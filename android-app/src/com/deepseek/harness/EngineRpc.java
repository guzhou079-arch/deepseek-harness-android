package com.deepseek.harness;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/** Bounded, authenticated client for the engine RPC wire. */
final class EngineRpc {
    private static final int MAX_RESPONSE = 2 * 1024 * 1024;
    private EngineRpc() {}

    static JSONObject call(File logFile, int port, String method, JSONObject request) throws Exception {
        if (!method.matches("[A-Za-z][A-Za-z0-9]*/[A-Za-z][A-Za-z0-9]*")) {
            throw new IllegalArgumentException("Invalid RPC method");
        }
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Invalid port");
        String base = "http://127.0.0.1:" + port;
        String cookie = authenticate(base, latestToken(logFile));
        String rpcId = "android-" + UUID.randomUUID().toString();
        JSONObject args = new JSONObject().put("request", request);
        JSONObject wire = new JSONObject().put("type", "client-request").put("rpcId", rpcId)
                .put("method", method).put("payload", new JSONObject().put("args", args));
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(base + "/api/" + method).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(30000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Cookie", cookie);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setDoOutput(true);
            byte[] body = wire.toString().getBytes("UTF-8");
            connection.setFixedLengthStreamingMode(body.length);
            OutputStream out = connection.getOutputStream();
            try { out.write(body); } finally { out.close(); }
            if (connection.getResponseCode() != 200) {
                throw new java.io.IOException("RPC HTTP " + connection.getResponseCode());
            }
            String type = connection.getContentType();
            if (type == null || !type.toLowerCase(java.util.Locale.US).startsWith("application/json")) {
                throw new java.io.IOException("RPC response is not JSON");
            }
            return parseResponse(readBounded(connection.getInputStream()), rpcId);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    static JSONObject prompt(String sessionId, String text) throws Exception {
        return new JSONObject().put("requestId", "android-task-" + UUID.randomUUID().toString())
                .put("sessionId", sessionId).put("mode", "queue")
                .put("content", new org.json.JSONArray().put(new JSONObject().put("type", "text").put("text", text)));
    }

    static JSONObject parseResponse(String json, String rpcId) throws Exception {
        JSONObject response = new JSONObject(json);
        if (!"server-response".equals(response.optString("type")) || !rpcId.equals(response.optString("rpcId"))) {
            throw new java.io.IOException("Unexpected RPC response envelope");
        }
        if (response.has("error")) {
            throw new java.io.IOException("RPC rejected: " + response.getJSONObject("error").optString("code", "unknown"));
        }
        JSONObject result = response.optJSONObject("result");
        if (result == null || !result.optBoolean("ok", false)) {
            throw new java.io.IOException("RPC did not return a value");
        }
        return result.getJSONObject("value");
    }

    static String latestToken(File logFile) throws Exception {
        RandomAccessFile log = new RandomAccessFile(logFile, "r");
        String tail;
        try {
            long length = log.length();
            int bytes = (int) Math.min(length, 256 * 1024L);
            log.seek(length - bytes);
            byte[] buffer = new byte[bytes];
            log.readFully(buffer);
            tail = new String(buffer, "UTF-8");
        } finally { log.close(); }
        Matcher matcher = Pattern.compile("[?&]token=([A-Za-z0-9_-]+)").matcher(tail);
        String token = null;
        while (matcher.find()) token = matcher.group(1);
        if (token == null) throw new java.io.IOException("Engine launch token unavailable");
        return token;
    }

    private static String authenticate(String base, String token) throws Exception {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(base + "/?token=" + token).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            int status = connection.getResponseCode();
            if (status != 303) throw new java.io.IOException("Engine authentication HTTP " + status);
            String cookie = connection.getHeaderField("Set-Cookie");
            if (cookie == null || cookie.indexOf('=') < 1) throw new java.io.IOException("Engine authentication did not set a cookie");
            int end = cookie.indexOf(';');
            return end < 0 ? cookie : cookie.substring(0, end);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readBounded(InputStream stream) throws Exception {
        try {
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = stream.read(buffer)) != -1) {
                if (body.size() + n > MAX_RESPONSE) throw new java.io.IOException("RPC response exceeds limit");
                body.write(buffer, 0, n);
            }
            return new String(body.toByteArray(), "UTF-8");
        } finally { stream.close(); }
    }
}
