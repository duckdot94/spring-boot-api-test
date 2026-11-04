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
    // /api/ask/stream 은 답변을 NDJSON 으로 한 줄씩 보낸다.
    //   {"delta":"조각"} … {"done":true,"model":"..."}  (오류: {"error":"..."})
    // 이전 대화는 API 의 history 필드({question, answer} 배열)로 전달한다.
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
        var parsedUpTo = 0;   // 이미 처리한 위치. 줄바꿈으로 끝난 완성된 줄만 파싱한다.

        function consume(text) {
            var end = text.lastIndexOf('\n');
            if (end < parsedUpTo) return;
            text.slice(parsedUpTo, end).split('\n').forEach(function (line) {
                if (!line.trim()) return;
                var o = parseJson(line);
                if (o.delta) answer += o.delta;
                if (o.error) errMsg = o.error;
                if (o.done) { done = true; model = o.model || model; }
            });
            parsedUpTo = end + 1;
            if (answer) {
                $bot.attr('class', 'msg bot').text(answer); // 도착한 만큼 바로 표시
                scrollChat();
            }
        }

        var body = { question: q, history: history.slice(-MAX_HISTORY) };
        extFetch('POST', '/api/ask/stream', JSON.stringify(body), consume)
            .then(function (r) {
                if (r.status !== 200) { // 스트림 시작 전 오류 (JSON)
                    $bot.attr('class', 'msg err').text(parseJson(r.text).error || ('오류 (HTTP ' + r.status + ')'));
                    return;
                }
                consume(r.text.slice(-1) === '\n' ? r.text : r.text + '\n');
                if (model) $('#chatModel').text(model);
                if (done && !errMsg) {
                    // 성공한 턴만 기록에 남긴다
                    history.push({ question: q, answer: answer });
                    saveHistory();
                    return;
                }
                var msg = errMsg || '응답이 중간에 끊겼습니다.';
                if (answer) addMsg('err', msg); else $bot.attr('class', 'msg err').text(msg);
            })
            .catch(function () {
                $bot.attr('class', 'msg err').text('프록시 호출에 실패했습니다.');
            })
            .finally(function () {
                $('#chatSend').prop('disabled', false);
                $('#chatInput').focus();
            });
    });

    $('.nav-link[data-target="chat"]').on('click', function () { $('#chatInput').focus(); });
});
