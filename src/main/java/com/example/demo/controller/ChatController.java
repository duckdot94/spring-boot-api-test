package com.example.demo.controller;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.codec.DecodingException;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientRequestException;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import io.netty.channel.ChannelOption;
import io.netty.handler.timeout.ReadTimeoutException;
import io.netty.handler.timeout.ReadTimeoutHandler;
import reactor.core.publisher.Flux;
import reactor.netty.http.client.HttpClient;

/**
 * 채팅 전용 엔드포인트. WebClient 로 외부 API(/api/ask/stream, NDJSON)를 논블로킹으로 읽어
 * SSE(text/event-stream) 로 변환해 내려준다. 외부 호출 경로는 서버에 고정되어 있다.
 *
 * 이벤트
 *   delta  {"text":"조각"}          답변 조각 (여러 번)
 *   done   {"model":"gemma3:12b"}   정상 종료
 *   error  {"message":"..."}        오류 (HTTP 상태는 이미 200 이므로 이벤트로 전달)
 *   (주석) ": keepalive"            첫 토큰이 늦을 때 중간 장비가 연결을 끊지 않도록 15초마다 전송
 */
@RestController
public class ChatController {

    private static final Logger log = LoggerFactory.getLogger(ChatController.class);

    private static final int MAX_QUESTION_LENGTH = 10_000;
    private static final int MAX_HISTORY = 20;
    private static final int MAX_HISTORY_TEXT_LENGTH = 20_000;
    private static final Duration HEARTBEAT = Duration.ofSeconds(15);
    private static final Duration TOTAL_TIMEOUT = Duration.ofMinutes(5);

    public record Qa(String question, String answer) { }

    public record ChatRequest(String question, List<Qa> history) { }

    private final WebClient webClient;
    private final ObjectMapper mapper;

    public ChatController(@Value("${external.api.base-url}") String baseUrl, ObjectMapper mapper) {
        this.mapper = mapper;
        HttpClient http = HttpClient.create()
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 3000)
                // 청크 사이 무응답이 길어지면 끊는다 (LLM 첫 토큰 대기 포함)
                .doOnConnected(c -> c.addHandlerLast(new ReadTimeoutHandler(180, TimeUnit.SECONDS)));
        this.webClient = WebClient.builder()
                .baseUrl(baseUrl)
                .clientConnector(new ReactorClientHttpConnector(http))
                .build();
    }

    @PostMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> stream(@RequestBody ChatRequest req) {
        String invalid = validate(req);
        if (invalid != null) {
            return Flux.just(event("error", Map.of("message", invalid)));
        }
        List<Qa> history = req.history() == null ? List.of()
                : req.history().subList(Math.max(0, req.history().size() - MAX_HISTORY), req.history().size());

        Flux<ServerSentEvent<String>> events = webClient.post()
                .uri("/api/ask/stream")
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.ALL)
                .bodyValue(Map.of("question", req.question(), "history", history))
                .retrieve()
                .onStatus(HttpStatusCode::isError, res -> res.bodyToMono(String.class).defaultIfEmpty("")
                        .map(body -> new UpstreamException(res.statusCode().value(), body)))
                // NDJSON: 줄 단위로 분리되어 한 줄씩 들어온다
                .bodyToFlux(String.class)
                .<ServerSentEvent<String>>handle((line, sink) -> {
                    ServerSentEvent<String> ev = toEvent(line);
                    if (ev != null) {
                        sink.next(ev);
                    }
                })
                .timeout(TOTAL_TIMEOUT)
                .onErrorResume(e -> {
                    log.warn("chat stream failed: {}", e.toString());
                    return Flux.just(event("error", Map.of("message", userMessage(e))));
                });

        // events 를 한 번만 구독(publish)하면서 하트비트를 섞는다. events 가 끝나면 하트비트도 멈춘다.
        // 브라우저가 연결을 끊으면 구독이 취소되고, WebClient 가 외부 API 연결도 닫는다.
        return events.publish(shared -> Flux.merge(
                shared,
                Flux.interval(HEARTBEAT)
                        .<ServerSentEvent<String>>map(i -> ServerSentEvent.<String>builder().comment("keepalive").build())
                        .takeUntilOther(shared.ignoreElements())));
    }

    private String validate(ChatRequest req) {
        if (req == null || req.question() == null || req.question().isBlank()) {
            return "질문을 입력하세요.";
        }
        if (req.question().length() > MAX_QUESTION_LENGTH) {
            return "질문은 " + MAX_QUESTION_LENGTH + "자 이하여야 합니다.";
        }
        if (req.history() != null) {
            for (Qa qa : req.history()) {
                if (qa == null || qa.question() == null || qa.answer() == null
                        || qa.question().length() > MAX_HISTORY_TEXT_LENGTH
                        || qa.answer().length() > MAX_HISTORY_TEXT_LENGTH) {
                    return "대화 기록 형식이 올바르지 않습니다.";
                }
            }
        }
        return null;
    }

    /** 외부 API 의 NDJSON 한 줄을 SSE 이벤트로 변환한다. 알 수 없는 줄은 건너뛴다(null). */
    private ServerSentEvent<String> toEvent(String line) {
        if (line.isBlank()) {
            return null;
        }
        JsonNode node;
        try {
            node = mapper.readTree(line);
        } catch (JsonProcessingException e) {
            return null;
        }
        if (node.hasNonNull("delta")) {
            return event("delta", Map.of("text", node.get("delta").asText()));
        }
        if (node.path("done").asBoolean(false)) {
            return event("done", Map.of("model", node.path("model").asText("")));
        }
        if (node.hasNonNull("error")) {
            // 내부 오류 문구는 고객에게 노출하지 않고 로그에만 남긴다.
            log.warn("upstream stream error: {}", node.get("error").asText());
            return event("error", Map.of("message", "답변을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요."));
        }
        return null;
    }

    private ServerSentEvent<String> event(String name, Object data) {
        try {
            // JSON 은 한 줄이라 SSE 의 data 줄바꿈 문제가 없다.
            return ServerSentEvent.<String>builder().event(name).data(mapper.writeValueAsString(data)).build();
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private String userMessage(Throwable e) {
        Throwable t = e;
        while (t != null) {
            if (t instanceof TimeoutException || t instanceof ReadTimeoutException) {
                return "응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
            }
            if (t instanceof WebClientRequestException) {
                return "서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.";
            }
            if (t instanceof DecodingException) {
                break;
            }
            t = t.getCause();
        }
        return "답변을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }

    /** 외부 API 가 오류 상태로 응답했을 때. 상세 내용은 로그로만 사용한다. */
    private static class UpstreamException extends RuntimeException {
        UpstreamException(int status, String body) {
            super("upstream HTTP " + status + ": " + body);
        }
    }
}
