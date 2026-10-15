package com.deepseek.harness;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Environment;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.util.*;

/** Overview of both the app alarms and the optional dsh-life database. */
final class ScheduleBridge {
    private static File lifeFile() {
        return new File(Environment.getExternalStorageDirectory(), "DeepSeekHarness/life.db");
    }
    static boolean lifeEnabled(Context ctx, String id) throws Exception {
        if (!lifeFile().isFile()) return false;
        SQLiteDatabase db = SQLiteDatabase.openDatabase(lifeFile().getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
        try {
            Cursor c = db.rawQuery("SELECT enabled FROM scheduled_tasks WHERE id = ?", new String[]{id});
            try { return c.moveToNext() && c.getInt(0) == 1; } finally { c.close(); }
        } finally { db.close(); }
    }
    static JSONObject list(Context ctx) throws Exception {
        JSONObject out = new JSONObject(); JSONArray items = new JSONArray();
        Map<String, List<String>> wakeIds = new HashMap<String, List<String>>();
        for (ScheduledTaskStore.Task t : new ScheduledTaskStore(ctx.getFilesDir()).list()) {
            if (!t.lifeTaskId.isEmpty()) {
                List<String> ids = wakeIds.get(t.lifeTaskId);
                if (ids == null) { ids = new ArrayList<String>(); wakeIds.put(t.lifeTaskId, ids); }
                ids.add(t.id); continue;
            }
            JSONObject row = new JSONObject();
            row.put("source", "app"); row.put("id", t.id); row.put("name", t.text);
            row.put("repeat", t.repeat); row.put("intervalMin", t.intervalMin);
            row.put("next_run_at", t.triggerAt); row.put("enabled", true);
            row.put("last_status", t.triggerAt <= System.currentTimeMillis() ? "待核对执行记录" : "等待触发");
            items.put(row);
        }
        if (lifeFile().isFile()) {
            SQLiteDatabase db = null; Cursor cursor = null;
            try {
                db = SQLiteDatabase.openDatabase(lifeFile().getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
                cursor = db.rawQuery("SELECT id,name,cron_expr,enabled,last_status,next_run_at FROM scheduled_tasks ORDER BY id", null);
                while (cursor.moveToNext()) {
                    JSONObject row = new JSONObject(); String id = cursor.getString(0); row.put("source", "life");
                    row.put("id", id); row.put("name", cursor.getString(1)); row.put("cron_expr", cursor.getString(2));
                    row.put("enabled", cursor.getInt(3) == 1); row.put("last_status", cursor.getString(4));
                    row.put("next_run_at", cursor.isNull(5) ? 0L : cursor.getLong(5));
                    List<String> ids = wakeIds.remove(id);
                    row.put("wakeTaskIds", new JSONArray(ids == null ? Collections.<String>emptyList() : ids)); items.put(row);
                }
            } catch (Exception e) { out.put("lifeError", e.toString()); }
            finally { if (cursor != null) cursor.close(); if (db != null) db.close(); }
        }
        // An unreadable/deleted life DB must not hide its still-registered native wake alarms.
        for (Map.Entry<String, List<String>> e : wakeIds.entrySet()) for (String id : e.getValue()) {
            JSONObject row = new JSONObject(); row.put("source", "app"); row.put("id", id);
            row.put("name", "生活助理唤醒: " + e.getKey()); row.put("enabled", true);
            row.put("last_status", "生活助理记录不可用"); row.put("lifeTaskId", e.getKey()); items.put(row);
        }
        JSONArray history = new JSONArray();
        try { for (String line : ScheduleExecutor.history(ctx, 50)) history.put(line); }
        catch (IOException e) { out.put("historyError", e.toString()); }
        out.put("ok", true); out.put("items", items); out.put("history", history); return out;
    }
    static JSONObject cancel(Context ctx, String source, String id) throws Exception {
        if (id == null || id.isEmpty() || id.length() > 200) throw new IllegalArgumentException("缺少有效 taskId");
        JSONObject out = new JSONObject();
        synchronized (ScheduledTaskStore.LOCK) {
            if ("app".equals(source)) {
                String warning = ScheduleAlarms.cancel(ctx, id);
                if (warning != null) out.put("warning", warning);
                ScheduleExecutor.log(ctx, "任务已取消 taskId=" + id); out.put("ok", true);
            } else if ("life".equals(source)) {
                if (!lifeFile().isFile()) throw new IllegalArgumentException("生活助理任务库不存在");
                SQLiteDatabase db = SQLiteDatabase.openDatabase(lifeFile().getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE);
                int count;
                try {
                    android.content.ContentValues values = new android.content.ContentValues(); values.put("enabled", 0);
                    count = db.update("scheduled_tasks", values, "id = ?", new String[]{id});
                } finally { db.close(); }
                out.put("ok", count > 0); if (count == 0) out.put("error", "任务不存在");
                if (count > 0) {
                    int removed = 0; String warning = null;
                    for (ScheduledTaskStore.Task t : new ScheduledTaskStore(ctx.getFilesDir()).list()) if (id.equals(t.lifeTaskId)) {
                        try { warning = ScheduleAlarms.cancel(ctx, t.id); removed++; }
                        catch (Exception e) { warning = "生活助理已禁用，唤醒闹钟清理延后: " + e.toString(); }
                    }
                    out.put("wakeCancelled", removed); if (warning != null) out.put("warning", warning);
                    ScheduleExecutor.log(ctx, "生活助理任务已禁用 lifeTaskId=" + id);
                }
            } else throw new IllegalArgumentException("source 仅支持 app/life");
        }
        out.put("taskId", id); out.put("source", source);
        out.put("hint", "已阻止后续触发；已被调度器接收的执行不会被终止"); return out;
    }
}
