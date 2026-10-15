package com.deepseek.harness;

import java.io.*;
import java.util.*;

/** One atomic registry for tasks, consumed deliveries and cancellation tombstones. */
public final class ScheduledTaskStore {
    public static final Object LOCK = new Object();
    private final File tasks;
    private final File legacyCancelled;
    public ScheduledTaskStore(File filesDir) {
        tasks = new File(filesDir, "scheduled-tasks.json");
        legacyCancelled = new File(filesDir, "scheduled-cancelled.txt");
    }
    public static final class Task {
        public final String id, repeat, text, lifeTaskId;
        public final long triggerAt;
        public final int intervalMin;
        public final int dailyHour, dailyMinute, dailySecond, dailyMillis;
        public Task(String id, long at, String repeat, int interval, String text) {
            this(id, at, repeat, interval, text, timeOf(at), "");
        }
        private Task(String id, long at, String repeat, int interval, String text, int[] time, String lifeId) {
            this.id = id; this.triggerAt = at; this.repeat = repeat;
            this.intervalMin = interval; this.text = text; this.lifeTaskId = lifeId;
            dailyHour = time[0]; dailyMinute = time[1]; dailySecond = time[2]; dailyMillis = time[3];
        }
        public Task withDailyTime(int hour, int minute, int second, int millis) {
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 || millis < 0 || millis > 999)
                throw new IllegalArgumentException("Invalid daily time");
            return new Task(id, triggerAt, repeat, intervalMin, text, new int[]{hour, minute, second, millis}, lifeTaskId);
        }
        public Task at(long next) {
            return new Task(id, next, repeat, intervalMin, text,
                    new int[]{dailyHour, dailyMinute, dailySecond, dailyMillis}, lifeTaskId);
        }
        public Task withLifeTask(String lifeId) {
            if (!validId(lifeId)) throw new IllegalArgumentException("Invalid life task id");
            return new Task(id, triggerAt, repeat, intervalMin, text,
                    new int[]{dailyHour, dailyMinute, dailySecond, dailyMillis}, lifeId);
        }
        public String line() {
            return id + "|" + triggerAt + "|" + repeat + "|" + intervalMin + "|"
                    + text.replace("\r", " ").replace("\n", " ");
        }
        public static Task parse(String line) {
            try {
                String[] p = line.split("\\|", 5);
                if (p.length < 5 || !validId(p[0])) return null;
                Task t = new Task(p[0], Long.parseLong(p[1]), p[2], Integer.parseInt(p[3]), p[4]);
                validate(t); return t;
            } catch (RuntimeException e) { return null; }
        }
    }
    private static int[] timeOf(long at) {
        Calendar c = Calendar.getInstance(); c.setTimeInMillis(at);
        return new int[]{c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE), c.get(Calendar.SECOND), c.get(Calendar.MILLISECOND)};
    }
    private static boolean validId(String id) {
        return id != null && !id.isEmpty() && id.length() <= 200 && !id.startsWith("#")
                && id.indexOf('|') < 0 && id.indexOf('\n') < 0 && id.indexOf('\r') < 0;
    }
    private static void validate(Task t) {
        if (t == null || !validId(t.id) || t.triggerAt <= 0 || t.text == null
                || !("once".equals(t.repeat) || "daily".equals(t.repeat) || "interval".equals(t.repeat))
                || ("interval".equals(t.repeat) && t.intervalMin < 1))
            throw new IllegalArgumentException("Invalid scheduled task");
    }
    private static final class State {
        final Map<String, Task> active = new LinkedHashMap<String, Task>();
        final Set<String> cancelled = new LinkedHashSet<String>();
        final Map<String, Long> delivered = new LinkedHashMap<String, Long>();
        final List<String> unknown = new ArrayList<String>();
    }
    private static List<String> lines(File f) throws IOException {
        List<String> out = new ArrayList<String>();
        if (!f.exists()) return out;
        if (!f.isFile()) throw new IOException("Registry is not a regular file: " + f.getName());
        BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(f), "UTF-8"));
        try { String s; while ((s = r.readLine()) != null) out.add(s); } finally { r.close(); }
        return out;
    }
    private State load() throws IOException {
        State s = new State();
        Map<String, int[]> daily = new HashMap<String, int[]>();
        Map<String, String> life = new HashMap<String, String>();
        for (String line : lines(tasks)) {
            if ("#dsh-schedule-v2".equals(line) || line.isEmpty()) continue;
            String[] p = line.split("\\|", -1);
            try {
                if (p[0].equals("#cancel")) {
                    if (p.length != 2 || !validId(p[1])) throw new IllegalArgumentException();
                    s.cancelled.add(p[1]);
                } else if (p[0].equals("#delivered")) {
                    if (p.length != 3 || !validId(p[1])) throw new IllegalArgumentException();
                    s.delivered.put(p[1], Long.parseLong(p[2]));
                } else if (p[0].equals("#life")) {
                    if (p.length != 3 || !validId(p[1]) || !validId(p[2])) throw new IllegalArgumentException();
                    life.put(p[1], p[2]);
                } else if (p[0].equals("#daily")) {
                    if (p.length != 6 || !validId(p[1])) throw new IllegalArgumentException();
                    daily.put(p[1], new int[]{Integer.parseInt(p[2]), Integer.parseInt(p[3]), Integer.parseInt(p[4]), Integer.parseInt(p[5])});
                } else {
                    Task t = Task.parse(line);
                    if (t != null) s.active.put(t.id, t); else s.unknown.add(line);
                }
            } catch (RuntimeException e) { throw new IOException("Invalid task registry metadata", e); }
        }
        for (String id : lines(legacyCancelled)) if (validId(id)) s.cancelled.add(id);
        for (String id : s.cancelled) s.active.remove(id);
        try {
            for (Map.Entry<String, int[]> e : daily.entrySet()) {
                Task t = s.active.get(e.getKey()); int[] v = e.getValue();
                if (t != null) s.active.put(t.id, t.withDailyTime(v[0], v[1], v[2], v[3]));
            }
            for (Map.Entry<String, String> e : life.entrySet()) {
                Task t = s.active.get(e.getKey());
                if (t != null) s.active.put(t.id, t.withLifeTask(e.getValue()));
            }
        } catch (RuntimeException e) { throw new IOException("Invalid daily/life task metadata", e); }
        return s;
    }
    private void save(State s) throws IOException {
        File tmp = new File(tasks.getParentFile(), tasks.getName() + ".tmp");
        FileOutputStream stream = new FileOutputStream(tmp);
        try {
            Writer w = new OutputStreamWriter(stream, "UTF-8");
            w.write("#dsh-schedule-v2\n");
            for (Task t : s.active.values()) {
                w.write(t.line()); w.write('\n');
                if (!t.lifeTaskId.isEmpty()) w.write("#life|" + t.id + "|" + t.lifeTaskId + "\n");
                if ("daily".equals(t.repeat)) w.write("#daily|" + t.id + "|" + t.dailyHour + "|" + t.dailyMinute + "|" + t.dailySecond + "|" + t.dailyMillis + "\n");
            }
            for (String id : s.cancelled) w.write("#cancel|" + id + "\n");
            for (Map.Entry<String, Long> e : s.delivered.entrySet()) w.write("#delivered|" + e.getKey() + "|" + e.getValue() + "\n");
            for (String row : s.unknown) { w.write(row); w.write('\n'); }
            w.flush(); stream.getFD().sync();
        } finally { stream.close(); }
        // Both files are in app-private filesDir. POSIX rename replaces the old file atomically.
        if (!tmp.renameTo(tasks)) throw new IOException("Cannot replace task registry");
    }
    public boolean isCancelled(String id) throws IOException {
        synchronized (LOCK) { return id != null && load().cancelled.contains(id); }
    }
    public Task get(String id) throws IOException {
        synchronized (LOCK) { return load().active.get(id); }
    }
    public List<Task> list() throws IOException {
        synchronized (LOCK) {
            List<Task> out = new ArrayList<Task>(load().active.values());
            Collections.sort(out, new Comparator<Task>() {
                public int compare(Task a, Task b) { return a.triggerAt < b.triggerAt ? -1 : a.triggerAt == b.triggerAt ? 0 : 1; }
            });
            return out;
        }
    }
    public void put(Task t) throws IOException {
        validate(t);
        synchronized (LOCK) {
            State s = load();
            if (s.cancelled.contains(t.id)) throw new IllegalStateException("Task is cancelled");
            s.active.put(t.id, t); save(s);
        }
    }
    /** One commit removes the task and installs a permanent cancellation fence. */
    public void cancel(String id) throws IOException {
        if (!validId(id)) throw new IllegalArgumentException("Invalid task id");
        synchronized (LOCK) {
            State s = load(); s.cancelled.add(id); s.active.remove(id); save(s);
        }
    }
    public void remove(String id) throws IOException {
        synchronized (LOCK) { State s = load(); s.active.remove(id); save(s); }
    }
    /** Consume only the current due occurrence, and advance/remove it in the same atomic commit. */
    public Task claim(String id, long deliveryAt, long now) throws IOException {
        synchronized (LOCK) {
            State s = load(); Task t = s.active.get(id);
            if (t == null || s.cancelled.contains(id) || t.triggerAt > now) return null;
            // Legacy alarms omitted triggerAt. They may consume the current due occurrence once.
            if (deliveryAt > 0 && deliveryAt != t.triggerAt) return null;
            Long consumed = s.delivered.get(id);
            if (consumed != null && (deliveryAt <= 0 || t.triggerAt <= consumed)) return null;
            long next = nextAt(t, now);
            s.delivered.put(id, t.triggerAt);
            if (next == 0) s.active.remove(id); else s.active.put(id, t.at(next));
            save(s); return t;
        }
    }
    public static long nextAt(long previous, String repeat, int interval, long now) {
        return nextAt(new Task("next", previous > 0 ? previous : now, repeat, interval, ""), now);
    }
    public static long nextAt(Task t, long now) {
        if ("interval".equals(t.repeat) && t.intervalMin > 0) {
            long period = t.intervalMin * 60000L;
            long steps = now < t.triggerAt ? 1 : (now - t.triggerAt) / period + 1;
            if (steps > (Long.MAX_VALUE - t.triggerAt) / period) throw new IllegalArgumentException("Next occurrence overflow");
            return t.triggerAt + steps * period;
        }
        if (!"daily".equals(t.repeat)) return 0;
        Calendar day = Calendar.getInstance(); day.setTimeInMillis(t.triggerAt);
        Calendar today = Calendar.getInstance(); today.setTimeInMillis(now);
        if (now > t.triggerAt) {
            day.set(Calendar.YEAR, today.get(Calendar.YEAR));
            day.set(Calendar.MONTH, today.get(Calendar.MONTH));
            day.set(Calendar.DAY_OF_MONTH, today.get(Calendar.DAY_OF_MONTH));
        } else day.add(Calendar.DAY_OF_MONTH, 1);
        for (;;) {
            // Use noon as the calendar-day anchor; the occurrence may fall in a DST gap.
            day.set(Calendar.HOUR_OF_DAY, 12); day.set(Calendar.MINUTE, 0);
            day.set(Calendar.SECOND, 0); day.set(Calendar.MILLISECOND, 0);
            Calendar at = (Calendar) day.clone();
            at.set(Calendar.HOUR_OF_DAY, t.dailyHour); at.set(Calendar.MINUTE, t.dailyMinute);
            at.set(Calendar.SECOND, t.dailySecond); at.set(Calendar.MILLISECOND, t.dailyMillis);
            long result = at.getTimeInMillis();
            if (result > now && result > t.triggerAt) return result;
            day.add(Calendar.DAY_OF_MONTH, 1);
        }
    }
}
