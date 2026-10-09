package com.deepseek.harness.vscreen;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Browser-origin fence for loopback bridges; native Node callers remain compatible. */
public final class LocalHttpFence {
    private static final int MAX_HEADER = 16384;
    private LocalHttpFence() {}

    public static String readHeader(InputStream input) throws IOException {
        StringBuilder text = new StringBuilder();
        int c;
        while ((c = input.read()) != -1) {
            text.append((char) c);
            if (text.length() > MAX_HEADER) throw new IOException("HTTP header exceeds limit");
            if (text.length() >= 4 && text.substring(text.length() - 4).equals("\r\n\r\n")) return text.toString();
        }
        throw new IOException("Incomplete HTTP header");
    }

    public static int rejection(String raw, int bridgePort, int enginePort) {
        if (raw == null || raw.length() > MAX_HEADER || !raw.endsWith("\r\n\r\n")) return 400;
        String[] lines = raw.split("\r\n");
        String[] request = lines[0].split(" ", -1);
        if (request.length != 3 || !request[2].matches("HTTP/1\\.[01]") || !request[1].startsWith("/")
                || request[1].startsWith("//") || request[1].indexOf('#') >= 0) return 400;
        if (!"GET".equals(request[0]) && !"POST".equals(request[0]) && !"HEAD".equals(request[0]) && !"OPTIONS".equals(request[0])) return 405;
        Map<String, String> headers = new HashMap<String, String>();
        for (int i = 1; i < lines.length; i++) {
            if (lines[i].isEmpty()) continue;
            int colon = lines[i].indexOf(':');
            if (colon < 1 || Character.isWhitespace(lines[i].charAt(0))) return 400;
            String key = lines[i].substring(0, colon).toLowerCase(Locale.US);
            if (headers.put(key, lines[i].substring(colon + 1).trim()) != null) return 400;
        }
        String host = headers.get("host");
        if (host == null || host.indexOf('/') >= 0 || host.indexOf('?') >= 0 || host.indexOf('#') >= 0
                || !isLoopbackUrl("http://" + host, bridgePort)) return 403;
        if (headers.containsKey("transfer-encoding")) return 400;
        String contentLength = headers.get("content-length");
        if (contentLength != null && !contentLength.matches("[0-9]{1,9}")) return 400;
        if ("cross-site".equals(headers.get("sec-fetch-site")) || "navigate".equals(headers.get("sec-fetch-mode"))) return 403;
        String origin = headers.get("origin");
        if (origin != null) {
            if (!isLoopbackUrl(origin, enginePort)) return 403;
            try {
                URI source = new URI(origin);
                if ((source.getRawPath() != null && !source.getRawPath().isEmpty())
                        || source.getRawQuery() != null || source.getRawFragment() != null) return 403;
            } catch (Exception invalid) { return 403; }
        }
        String referer = headers.get("referer");
        if (referer != null && !isLoopbackUrl(referer, enginePort)) return 403;
        if (origin == null && referer == null
                && (headers.containsKey("sec-fetch-mode") || headers.containsKey("sec-fetch-site"))) return 403;
        return 0;
    }

    /** Exact engine authority; rejects aliases, credentials and non-HTTP documents. */
    public static boolean isLoopbackUrl(String value, int expectedPort) {
        if (value == null || expectedPort < 1) return false;
        try {
            URI uri = new URI(value);
            if (!"http".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null) return false;
            String host = uri.getHost();
            if (host == null) return false;
            host = host.toLowerCase(Locale.US);
            if (!"127.0.0.1".equals(host) && !"localhost".equals(host) && !"[::1]".equals(host) && !"::1".equals(host)) return false;
            int port = uri.getPort() == -1 ? 80 : uri.getPort();
            return port == expectedPort;
        } catch (Exception invalid) { return false; }
    }

    /** Sub-resource policy: exact engine origin, or a scheme that cannot reach local files.
     *  Main-frame requests stay restricted to the engine origin (navigation is shell-handled).
     *  Pure string logic on purpose: the JVM fixture (AuditBoundaryTest) exercises it directly. */
    public static boolean resourceAllowed(String url, boolean mainFrame, int enginePort) {
        if (isLoopbackUrl(url, enginePort)) return true;
        if (mainFrame || url == null) return false;
        int colon = url.indexOf(':');
        if (colon <= 0) return false;
        String scheme = url.substring(0, colon).toLowerCase(Locale.US);
        return "http".equals(scheme) || "https".equals(scheme)
                || "blob".equals(scheme) || "data".equals(scheme) || "about".equals(scheme);
    }

    public static void reject(OutputStream output, int status) throws IOException {
        byte[] body = "{\"ok\":false,\"error\":\"Request rejected before bridge dispatch\"}".getBytes("UTF-8");
        output.write(("HTTP/1.1 " + status + " Rejected\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: "
                + body.length + "\r\nConnection: close\r\n\r\n").getBytes("UTF-8"));
        output.write(body);
        output.flush();
    }
}
