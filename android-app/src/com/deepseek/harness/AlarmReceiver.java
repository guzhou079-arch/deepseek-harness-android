package com.deepseek.harness;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Receives app alarms, keeps the registry current, and starts background execution. */
public class AlarmReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent intent) {
        if (intent == null) return;
        String id = intent.getStringExtra("taskId");
        String text = intent.getStringExtra("task");
        if (id == null || id.isEmpty()) return;
        if (text == null || text.isEmpty()) text = "定时任务时间到了";
        try {
            synchronized (ScheduledTaskStore.LOCK) {
                ScheduledTaskStore store = new ScheduledTaskStore(ctx.getFilesDir());
                ScheduledTaskStore.Task current = store.claim(id, intent.getLongExtra("triggerAt", 0L), System.currentTimeMillis());
                if (current == null) {
                    ScheduleExecutor.log(ctx, "忽略取消/重复/过期或提前投递 taskId=" + id); return;
                }
                text = current.text.isEmpty() ? "定时任务时间到了" : current.text;
                ScheduledTaskStore.Task next = store.get(id);
                if (next != null) {
                    try { ScheduleAlarms.register(ctx, next); }
                    catch (RuntimeException e) { ScheduleExecutor.log(ctx, "下次闹钟登记失败 taskId=" + id + ": " + e.toString()); }
                }
                String warning = ScheduleAlarms.retireLegacy(ctx, id);
                if (warning != null) ScheduleExecutor.log(ctx, warning + " taskId=" + id);
                ScheduleExecutor.log(ctx, "闹钟触发 taskId=" + id + " occurrence=" + current.triggerAt + " task=" + text);
                Intent svc = new Intent(ctx, EngineService.class);
                if (!current.lifeTaskId.isEmpty()) {
                    if (!ScheduleBridge.lifeEnabled(ctx, current.lifeTaskId)) {
                        ScheduleExecutor.log(ctx, "忽略禁用生活助理唤醒 lifeTaskId=" + current.lifeTaskId); return;
                    }
                    // Keep the app process alive without turning a local cron wake into an AI prompt.
                    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc); else ctx.startService(svc);
                    final Context app = ctx.getApplicationContext();
                    final PendingResult result = goAsync();
                    final java.util.concurrent.atomic.AtomicBoolean finished = new java.util.concurrent.atomic.AtomicBoolean();
                    final Runnable finish = new Runnable() {
                        @Override public void run() { if (finished.compareAndSet(false, true)) result.finish(); }
                    };
                    new Thread(new Runnable() {
                        @Override public void run() {
                            try { ScheduleExecutor.tickLife(app, finish); } finally { finish.run(); }
                        }
                    }, "life-alarm-tick").start();
                } else {
                    notifyTask(ctx, text);
                    // The same lock covers cancel and dispatch; an accepted execution can finish later.
                    svc.putExtra("scheduledTask", text);
                    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc); else ctx.startService(svc);
                }
            }
        } catch (Throwable t) { ScheduleExecutor.log(ctx, "闹钟处理失败 taskId=" + id + ": " + t.toString()); }
    }
    private static void notifyTask(Context ctx, String text) {
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            String channel = "dsh_schedule";
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(channel, "定时任务", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("AI 设置的定时提醒"); nm.createNotificationChannel(ch);
            }
            Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, channel) : new Notification.Builder(ctx);
            nm.notify(9001, b.setContentTitle("⏰ 定时任务").setContentText(text).setSmallIcon(R.drawable.ic_whale_black)
                    .setContentIntent(pi).setAutoCancel(true).build());
        } catch (Throwable t) { ScheduleExecutor.log(ctx, "任务通知失败: " + t.toString()); }
    }
}
