# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
mvn spring-boot:run          # run the app on http://localhost:8080
mvn -DskipTests package      # build the jar
mvn test                     # there is currently no src/test directory
```

Java 17 (`pom.xml`), Spring Boot 3.3.5. There is no lint step configured. `spring-boot-devtools` is on the classpath, but in practice front-end changes under `src/main/resources/static` were not served until the app was restarted, so restart after editing JS/CSS.

## Architecture

A Thymeleaf page (`templates/main.html`) with jQuery tabs, plus a streaming proxy to an **external LLM API that lives in a different project**. This repo does not contain that API.

- **External API**: `/Users/kihwanyu/Project/react/vite-react/React/server/` (Node, run with `npm run api`, listens on `127.0.0.1:8787`, calls local Ollama `gemma3:12b`). Base URL is `external.api.base-url` in `application.properties`. Endpoints the UI uses: `GET /api/health`, `POST /api/ask`, `POST /api/ask/stream`. Changes to streaming or request formats usually need edits in both projects, and the Node server must be restarted to pick them up.
- **Browser never calls the external API directly.** Two server-side paths exist:
  - **Chat: `ChatController`** (`POST /chat/stream`, body `{question, history}`). Uses **`WebClient`** (from `spring-boot-starter-webflux`, which sits next to `spring-boot-starter-web`, so the app still runs on Tomcat/MVC) to read the external `/api/ask/stream` NDJSON and returns `Flux<ServerSentEvent<String>>`. The upstream path is fixed in code; the browser cannot choose it. Events: `delta {"text"}`, `done {"model"}`, `error {"message"}`, plus a `: keepalive` comment every 15 s. All errors (validation, upstream 4xx/5xx, connect/read timeout) are sent as `error` events with a generic message and the detail is only logged, because the HTTP status is already 200 once streaming starts.
  - **Dev tool: `ExternalApiController`** (`POST /proxy/stream`, body `{method, path, body}`) used by the "외부 API 확인" panel. It uses `RestTemplate.execute` and copies the upstream response to the servlet response, flushing per read, passing status and `Content-Type` through (no-op error handler; connection failure becomes `502`). Only `GET/POST/PUT/DELETE` and paths starting with a single `/` are accepted. This is a generic proxy, so it must not be exposed to end users as is.
- **Front end** (`static/js/main.js`): the chat uses `streamSse()` (fetch + hand-written SSE parser, because `EventSource` is GET only); the external-API panel uses `extFetch()` (fetch + `ReadableStream` against `/proxy/stream`).
- **Client disconnect**: cancelling the `Flux` closes the upstream connection, which makes the Node API abort the Ollama generation. Tomcat only notices a closed client on a write, so while tokens flow this happens at once, but during a long silent wait it can take up to two heartbeats (about 30 s).
- **External stream format** (`/api/ask/stream`, NDJSON): `{"delta": "..."}` repeated, then `{"done": true, "model": "..."}`, or `{"error": "..."}` mid-stream. Errors before streaming starts are an ordinary JSON body with a non-200 status.
- **Conversation memory** is client-side only: `history` as `[{question, answer}]` in `sessionStorage` (key `chatHistoryV2`), last 10 pairs sent per request. `ChatController` caps it at 20 pairs and rejects oversized items. The external API ignores the `{role, content}` shape, so do not use it. A turn is saved only if `done` arrived with no `error`.

`MainController` only serves `/` and a demo `/api/hello`; that path prefix is unrelated to the external API's `/api/*`.
