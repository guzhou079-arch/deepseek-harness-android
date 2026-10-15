package com.deepseek.harness;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import java.util.*;

/** Unique identities, with safe migration of the old hash and shared requestCode=0 alarms. */
final class ScheduleAlarms {
    static Intent intent(Context ctx, ScheduledTaskStore.Task t) {
        Intent i = new Intent(ctx, AlarmReceiver.class);
        i.setData(Uri.parse("dsh-schedule://task/" + Uri.encode(t.id)));
        i.putExtra("taskId", t.id); i.putExtra("task", t.text);
        i.putExtra("triggerAt", t.triggerAt); i.putExtra("repeatType", t.repeat);
        i.putExtra("intervalMin", t.intervalMin); return i;
    }
    static void register(Context ctx, ScheduledTaskStore.Task t) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) throw new IllegalStateException("AlarmManager unavailable");
        PendingIntent pi = PendingIntent.getBroadcast(ctx, t.id.hashCode(), intent(ctx, t),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            Intent show = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent showPi = PendingIntent.getActivity(ctx, 1, show,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            if (Build.VERSION.SDK_INT >= 21) am.setAlarmClock(new AlarmManager.AlarmClockInfo(t.triggerAt, showPi), pi);
            else am.setExact(AlarmManager.RTC_WAKEUP, t.triggerAt, pi);
        } catch (RuntimeException e) {
            try {
                if (Build.VERSION.SDK_INT >= 23) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t.triggerAt, pi);
                else am.setExact(AlarmManager.RTC_WAKEUP, t.triggerAt, pi);
            } catch (RuntimeException unavailable) { am.set(AlarmManager.RTC_WAKEUP, t.triggerAt, pi); }
        }
    }
    private static void collect(Context ctx, Set<PendingIntent> out, int code, Intent i) {
        // Older APKs may have used mutable PendingIntents. Neither lookup creates a new alarm.
        PendingIntent immutable = PendingIntent.getBroadcast(ctx, code, i,
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
        if (immutable != null) out.add(immutable);
        int mutable = Build.VERSION.SDK_INT >= 31 ? 0x02000000 : 0; // FLAG_MUTABLE, compiles with older android.jar.
        PendingIntent legacy = PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_NO_CREATE | mutable);
        if (legacy != null) out.add(legacy);
    }
    private static void cancelAll(AlarmManager am, Collection<PendingIntent> intents) {
        for (PendingIntent pi : intents) { am.cancel(pi); pi.cancel(); }
    }
    /** Restore all peers, including overdue ones, before deleting any colliding legacy slot. */
    static String retireLegacy(Context ctx, String id) {
        synchronized (ScheduledTaskStore.LOCK) {
            try {
                Set<PendingIntent> old = new LinkedHashSet<PendingIntent>();
                Intent legacy = new Intent(ctx, AlarmReceiver.class);
                collect(ctx, old, id.hashCode(), legacy); collect(ctx, old, 0, legacy);
                if (old.isEmpty()) return null;
                AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
                if (am == null) throw new IllegalStateException("AlarmManager unavailable");
                // If any registration fails, leave the old slots intact. The cancellation fence
                // still suppresses the target; a hash collision or shared slot cannot lose a peer.
                for (ScheduledTaskStore.Task peer : new ScheduledTaskStore(ctx.getFilesDir()).list()) register(ctx, peer);
                cancelAll(am, old); return null;
            } catch (Exception e) { return "旧闹钟清理延后: " + e.toString(); }
        }
    }
    /** Cancellation succeeds durably even if AlarmManager cleanup must be retried later. */
    static String cancel(Context ctx, String id) throws java.io.IOException {
        synchronized (ScheduledTaskStore.LOCK) {
            ScheduledTaskStore store = new ScheduledTaskStore(ctx.getFilesDir());
            boolean known = store.get(id) != null;
            store.cancel(id);
            try {
                AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
                if (am == null) throw new IllegalStateException("AlarmManager unavailable");
                Set<PendingIntent> exact = new LinkedHashSet<PendingIntent>();
                collect(ctx, exact, id.hashCode(), intent(ctx, new ScheduledTaskStore.Task(id, 1, "once", 0, "")));
                cancelAll(am, exact);
            } catch (RuntimeException e) { return "取消已登记，闹钟清理延后: " + e.toString(); }
            // For unknown IDs we cannot know who owns the shared slot. The tombstone is enough.
            return known ? retireLegacy(ctx, id) : null;
        }
    }
}
