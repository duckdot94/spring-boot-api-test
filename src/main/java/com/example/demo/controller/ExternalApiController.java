package com.example.demo.controller;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.ResponseErrorHandler;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

import com.fasterxml.jackson.databind.ObjectMapper;

import jakarta.servlet.http.HttpServletResponse;

/**
 * 외부 API(127.0.0.1:8787)를 RestTemplate 으로 대신 호출하고,
 * 응답을 버퍼링하지 않고 받는 즉시 브라우저로 흘려보내는 스트리밍 프록시.
 */
@RestController
public class ExternalApiController {

    private static final Set<String> ALLOWED_METHODS = Set.of("GET", "POST", "PUT", "DELETE");

    private final RestTemplate restTemplate;
    private final String baseUrl;
    private final ObjectMapper mapper;

    public ExternalApiController(@Value("${external.api.base-url}") String baseUrl, ObjectMapper mapper) {
        this.baseUrl = baseUrl;
        this.mapper = mapper;

        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(3000);
        factory.setReadTimeout(180000); // LLM 응답은 오래 걸릴 수 있음 (청크 사이 최대 대기 시간)

        this.restTemplate = new RestTemplate(factory);
        // 4xx/5xx 도 예외 대신 그대로 브라우저에 전달한다.
        this.restTemplate.setErrorHandler(new ResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) {
                return false;
            }

            @Override
            public void handleError(ClientHttpResponse response) {
                // no-op
            }
        });
    }

    @GetMapping("/proxy/info")
    public Map<String, String> info() {
        return Map.of("baseUrl", baseUrl);
    }

    /** 요청: {"method":"GET","path":"/api/health","body":"..."} → 외부 API 응답을 그대로 스트리밍 */
    @PostMapping("/proxy/stream")
    public void stream(@RequestBody Map<String, String> req, HttpServletResponse resp) throws IOException {
        String method = req.getOrDefault("method", "GET").toUpperCase();
        String path = req.getOrDefault("path", "/");
        String body = req.get("body");

        // 고정된 base URL 밖으로 나가지 못하도록 상대 경로만 허용
        if (!ALLOWED_METHODS.contains(method)) {
            writeError(resp, 400, "허용되지 않는 메서드입니다: " + method);
            return;
        }
        if (!path.startsWith("/") || path.startsWith("//") || path.contains("://")) {
            writeError(resp, 400, "경로는 '/'로 시작하는 상대 경로여야 합니다.");
            return;
        }
        URI uri;
        try {
            uri = URI.create(baseUrl + path);
        } catch (IllegalArgumentException e) {
            writeError(resp, 400, "잘못된 경로입니다.");
            return;
        }

        try {
            restTemplate.execute(uri, HttpMethod.valueOf(method),
                    request -> {
                        if (body != null && !body.isBlank()) {
                            request.getHeaders().setContentType(MediaType.APPLICATION_JSON);
                            request.getBody().write(body.getBytes(StandardCharsets.UTF_8));
                        }
                    },
                    response -> {
                        // 상태 코드와 Content-Type 을 그대로 전달
                        resp.setStatus(response.getStatusCode().value());
                        MediaType contentType = response.getHeaders().getContentType();
                        if (contentType != null) {
                            resp.setContentType(contentType.toString());
                        }
                        resp.setHeader("Cache-Control", "no-cache");
                        resp.setHeader("X-Accel-Buffering", "no");

                        // 읽는 즉시 flush → 청크 단위로 브라우저에 전달
                        OutputStream out = resp.getOutputStream();
                        try (InputStream in = response.getBody()) {
                            byte[] buf = new byte[1024];
                            int n;
                            while ((n = in.read(buf)) != -1) {
                                out.write(buf, 0, n);
                                out.flush();
                            }
                        }
                        return null;
                    });
        } catch (RestClientException e) {
            if (!resp.isCommitted()) {
                writeError(resp, 502, "연결 실패: " + e.getMessage());
            }
            // 이미 전송이 시작된 뒤의 오류는 연결을 끊는 것으로 알린다.
        }
    }

    private void writeError(HttpServletResponse resp, int status, String message) throws IOException {
        resp.reset();
        resp.setStatus(status);
        resp.setContentType("application/json;charset=UTF-8");
        resp.getWriter().write(mapper.writeValueAsString(Map.of("error", message)));
    }
}
