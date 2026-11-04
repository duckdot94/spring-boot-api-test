package com.example.demo.controller;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseBody;

@Controller
public class MainController {

    @GetMapping("/")
    public String main() {
        return "main";
    }

    /** jQuery AJAX 데모용 API */
    @GetMapping("/api/hello")
    @ResponseBody
    public Map<String, Object> hello(@RequestParam(defaultValue = "Guest") String name) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("message", "안녕하세요, " + name + "님!");
        result.put("serverTime", LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));
        return result;
    }
}
