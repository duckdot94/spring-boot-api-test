$(function () {
    // 탭 전환
    $('.nav-link').on('click', function (e) {
        e.preventDefault();
        $('.nav-link').removeClass('active');
        $(this).addClass('active');
        $('.panel').hide();
        $('#' + $(this).data('target')).prop('hidden', false).fadeIn(200);
    });

    // AJAX 호출
    $('#helloForm').on('submit', function (e) {
        e.preventDefault();
        $.getJSON('/api/hello', { name: $('#nameInput').val() || 'Guest' })
            .done(function (data) { $('#result').text(JSON.stringify(data, null, 2)); })
            .fail(function () { $('#result').text('요청에 실패했습니다.'); });
    });

    // ===== 외부 API 호출 (스트리밍) =====
    // /proxy/stream 은 외부 API 응답을 받는 즉시 청크 단위로 내려준다.
    // onChunk(누적텍스트) 가 청크마다 호출되고, 완료되면 {status, text, elapsed} 로 resolve 된다.
    function extFetch(method, path, body, onChunk) {
        var t0 = Date.now();
        return fetch('/proxy/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: method, path: path, body: body })
        }).then(function (res) {
            var reader = res.body.getReader();
            var decoder = new TextDecoder();
            var text = '';
            function pump() {
                return reader.read().then(function (r) {
                    if (r.done) {
                        text += decoder.decode();
                        return { status: res.status, text: text, elapsed: Date.now() - t0 };
                    }
                    text += decoder.decode(r.value, { stream: true });
                    if (onChunk) onChunk(text);
                    return pump();
                });
            }
            return pump();
        });
    }

    function prettyJson(t) {
        try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { return t; }
    }

    function parseJson(t) {
        try { return JSON.parse(t || '{}'); } catch (e) { return {}; }
    }

    function showResult(r) {
        $('#extResult').text('HTTP ' + r.status + ' (' + r.elapsed + 'ms)\n\n' + prettyJson(r.text));
    }

    function callExt(method, path, body) {
        $('#extResult').text('요청 중…');
        return extFetch(method, path, body, function (partial) {
            $('#extResult').text(partial); // 도착하는 대로 표시
        }).then(showResult)
          .catch(function () { $('#extResult').text('프록시 호출에 실패했습니다.'); });
    }

    function checkHealth() {
        $('#extStatus').attr('class', 'badge').text('확인 중…');
        $('#extResult').text('요청 중…');
        return extFetch('GET', '/api/health').then(function (r) {
            var ok = r.status === 200;
            $('#extStatus').attr('class', 'badge ' + (ok ? 'ok' : 'fail')).text(ok ? '정상' : '오류');
            showResult(r);
        }).catch(function () {
            $('#extStatus').attr('class', 'badge fail').text('오류');
            $('#extResult').text('프록시 호출에 실패했습니다.');
        });
    }

    $.getJSON('/proxy/info').done(function (d) { $('#extBase').text(d.baseUrl); });

    $('.nav-link[data-target="ext"]').on('click', checkHealth);
    $('#healthBtn').on('click', checkHealth);
    $('#extForm').on('submit', function (e) {
        e.preventDefault();
        callExt($('#extMethod').val(), $('#extPath').val(), $('#extBody').val());
    });

    // ===== 채팅 =====
    // POST /chat/stream 은 SSE(text/event-stream)로 응답한다.
    //   event: delta  data: {"text":"조각"}      (여러 번)
    //   event: done   data: {"model":"..."}
    //   event: error  data: {"message":"..."}
    //   ": keepalive" 주석은 연결 유지용이라 무시한다.
    // EventSource 는 GET 만 지원하므로 fetch 로 읽고 SSE 를 직접 파싱한다.
    // 이전 대화는 history([{question, answer}]) 로 전달한다.
    function streamSse(url, payload, onEvent) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify(payload)
        }).then(function (res) {
            if (!res.ok) {
                onEvent({ event: 'error', data: JSON.stringify({ message: '요청에 실패했습니다. (HTTP ' + res.status + ')' }) });
                return;
            }
            var reader = res.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';

            function dispatch(block) {
                var name = 'message', data = [];
                block.split('\n').forEach(function (line) {
                    if (!line || line.charAt(0) === ':') return;           // 빈 줄, 주석(keepalive)
                    var i = line.indexOf(':');
                    var field = i < 0 ? line : line.slice(0, i);
                    var value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
                    if (field === 'event') name = value;
                    else if (field === 'data') data.push(value);
                });
                if (data.length) onEvent({ event: name, data: data.join('\n') });
            }

            function pump() {
                return reader.read().then(function (r) {
                    if (r.done) {
                        buffer += decoder.decode();
                        if (buffer.trim()) dispatch(buffer.replace(/\r\n/g, '\n'));
                        return;
                    }
                    buffer += decoder.decode(r.value, { stream: true });
                    buffer = buffer.replace(/\r\n/g, '\n');
                    var end;
                    while ((end = buffer.indexOf('\n\n')) >= 0) {   // 빈 줄이 이벤트의 끝
                        dispatch(buffer.slice(0, end));
                        buffer = buffer.slice(end + 2);
                    }
                    return pump();
                });
            }
            return pump();
        });
    }

    var MAX_HISTORY = 10;            // API 로 보낼 최근 질문/답변 쌍 수 (API 최대 20)
    var STORE_KEY = 'chatHistoryV2';
    var history = [];                // [{question, answer}]

    function saveHistory() {
        try { sessionStorage.setItem(STORE_KEY, JSON.stringify(history)); } catch (e) { }
    }

    function scrollChat() {
        $('#chatLog').scrollTop($('#chatLog')[0].scrollHeight);
    }

    function addMsg(cls, text) {
        var $m = $('<div class="msg">').addClass(cls).text(text); // .text()로 XSS 방지
        $('#chatLog').append($m);
        scrollChat();
        return $m;
    }

    function restoreHistory() {
        try { history = JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]'); } catch (e) { history = []; }
        history.forEach(function (h) { addMsg('user', h.question); addMsg('bot', h.answer); });
    }
    restoreHistory();

    $('#chatReset').on('click', function () {
        history = [];
        saveHistory();
        $('#chatLog').empty();
        $('#chatInput').focus();
    });

    $('#chatForm').on('submit', function (e) {
        e.preventDefault();
        var q = $('#chatInput').val().trim();
        if (!q) return;
        $('#chatInput').val('');
        addMsg('user', q);
        var $bot = addMsg('bot pending', '생각 중…');
        $('#chatSend').prop('disabled', true);

        var answer = '', model = '', errMsg = null, done = false;

        streamSse('/chat/stream', { question: q, history: history.slice(-MAX_HISTORY) }, function (ev) {
            var d = parseJson(ev.data);
            if (ev.event === 'delta') {
                answer += d.text || '';
                $bot.attr('class', 'msg bot').text(answer); // 도착한 만큼 바로 표시
                scrollChat();
            } else if (ev.event === 'done') {
                done = true;
                model = d.model || model;
            } else if (ev.event === 'error') {
                errMsg = d.message || '오류가 발생했습니다.';
            }
        }).then(function () {
            if (model) $('#chatModel').text(model);
            if (done && !errMsg) {
                // 성공한 턴만 기록에 남긴다
                history.push({ question: q, answer: answer });
                saveHistory();
                return;
            }
            var msg = errMsg || '응답이 중간에 끊겼습니다.';
            if (answer) addMsg('err', msg); else $bot.attr('class', 'msg err').text(msg);
        }).catch(function () {
            var msg = '서버에 연결하지 못했습니다.';
            if (answer) addMsg('err', msg); else $bot.attr('class', 'msg err').text(msg);
        }).finally(function () {
            $('#chatSend').prop('disabled', false);
            $('#chatInput').focus();
        });
    });

    $('.nav-link[data-target="chat"]').on('click', function () { $('#chatInput').focus(); });
});
