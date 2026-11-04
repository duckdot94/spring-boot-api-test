# springBootApiTst

Spring Boot + Thymeleaf + jQuery로 만든 메인 페이지입니다.
로컬에서 실행 중인 LLM API(Ollama 연동)를 확인하고, 답변이 생성되는 대로 화면에 보여 주는 채팅 메뉴를 제공합니다.

## 기능

| 메뉴 | 설명 |
|---|---|
| 홈 / 소개 | 기본 화면 |
| API 테스트 | 이 앱의 `/api/hello`를 jQuery AJAX로 호출하는 데모 |
| 외부 API 확인 | 외부 API의 헬스체크(`/api/health`) 상태 배지와, 메서드·경로·JSON 본문을 직접 넣어 보는 요청 도구. 응답은 도착하는 대로 표시 |
| 채팅 | 질문을 보내면 답변이 조각 단위로 말풍선에 이어서 표시. 이전 대화를 기억하고, "새 대화" 버튼으로 초기화 |

## 요구 사항

- Java 17
- Maven 3.x
- 외부 API 서버가 `http://127.0.0.1:8787`에서 실행 중일 것 (아래 [외부 API](#외부-api) 참고)

## 실행

```bash
mvn spring-boot:run
```

브라우저에서 <http://localhost:8080> 으로 접속합니다.

외부 API가 꺼져 있어도 앱은 실행됩니다. 이 경우 "외부 API 확인"과 "채팅" 메뉴에서만 연결 오류가 표시됩니다.

## 설정

`src/main/resources/application.properties`

| 키 | 기본값 | 설명 |
|---|---|---|
| `server.port` | `8080` | 이 앱의 포트 |
| `external.api.base-url` | `http://127.0.0.1:8787` | 호출할 외부 API 주소 |

## 구조

```
src/main
├── java/com/example/demo
│   ├── SpringBootApiTstApplication.java
│   └── controller
│       ├── MainController.java          # 메인 페이지, /api/hello
│       └── ExternalApiController.java   # 외부 API 스트리밍 프록시
└── resources
    ├── templates/main.html              # Thymeleaf 템플릿
    ├── static/js/main.js                # 탭 전환, 외부 API 확인, 채팅
    ├── static/css/main.css
    └── application.properties
```

## 동작 방식

브라우저는 외부 API를 직접 호출하지 않고, 이 앱의 프록시(`POST /proxy/stream`)를 거칩니다. CORS 문제를 피하고 허용 범위를 서버에서 제한하기 위해서입니다.

```
브라우저 ──fetch──▶ Spring /proxy/stream ──RestTemplate──▶ 외부 API (127.0.0.1:8787)
        ◀─ 청크 ──                        ◀─ 청크 ──
```

- `ExternalApiController`가 `RestTemplate.execute`로 외부 API를 호출하고, 응답을 버퍼링하지 않고 읽는 즉시 flush해서 브라우저로 전달합니다.
- 외부 API의 상태 코드와 `Content-Type`을 그대로 전달합니다. 4xx/5xx도 예외로 바꾸지 않습니다.
- 외부 API에 연결하지 못하면 `502`와 `{"error": "..."}`를 돌려줍니다.
- 연결 타임아웃은 3초, 응답 읽기 타임아웃은 180초입니다. LLM 응답이 느려도 기다릴 수 있고, API가 꺼져 있으면 빠르게 실패합니다.
- 브라우저는 `fetch`와 `ReadableStream`으로 청크를 읽어 화면을 갱신합니다.

### 프록시 API

`POST /proxy/stream`

```json
{ "method": "POST", "path": "/api/ask/stream", "body": "{\"question\":\"안녕\"}" }
```

| 필드 | 설명 |
|---|---|
| `method` | `GET`, `POST`, `PUT`, `DELETE` 중 하나 (기본 `GET`) |
| `path` | `/`로 시작하는 상대 경로. `//`로 시작하거나 `://`가 들어간 값은 `400` |
| `body` | 요청 본문 문자열 (선택, JSON으로 전송) |

`GET /proxy/info`는 현재 설정된 외부 API 주소를 반환합니다.

## 외부 API

별도 프로젝트의 Node 서버이며, 로컬 Ollama(`gemma3:12b`)를 호출합니다. 이 저장소에는 포함되어 있지 않습니다.
실행은 해당 프로젝트에서 `npm run api` 입니다. 이 앱이 사용하는 엔드포인트는 다음과 같습니다.

| 엔드포인트 | 설명 |
|---|---|
| `GET /api/health` | Ollama 연결과 모델 설치 여부 |
| `POST /api/ask` | `{question, history?, memo?}` → `{answer, model}` (응답이 완성된 뒤 한 번에 반환) |
| `POST /api/ask/stream` | 요청은 `/api/ask`와 같고, 응답은 NDJSON 스트림 |

`/api/ask/stream` 응답은 한 줄에 JSON 하나입니다.

```
{"delta":"안녕"}
{"delta":"하세요"}
{"done":true,"model":"gemma3:12b"}
```

스트림 도중 오류가 나면 `{"error":"..."}`가 옵니다.

### 대화 기록

채팅은 API의 `history` 필드(`[{question, answer}]`)로 이전 대화를 전달합니다. 최근 10쌍까지 보내며(API 최대 20쌍), 기록은 브라우저 `sessionStorage`에 저장되어 새로고침해도 유지되고 탭을 닫으면 사라집니다. 오류가 난 턴은 기록에 남기지 않습니다.
