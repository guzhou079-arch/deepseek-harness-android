package com.deepseek.harness;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import android.view.KeyEvent;

/**
 * 前台保活服务：引擎（node 服务器）运行期间常驻通知栏，
 * 让系统把本应用标记为高优先级进程，挂后台/锁屏不被杀掉，
 * AI 后台任务（对话、工具调用）可持续执行。
 * 兼任：蓝牙耳机按键唤醒 (MediaSession) 接收中心。
 */
public class EngineService extends Service {
    private static final String TAG = "EngineService";
    private static final String CHANNEL_ID = "dsh_engine";
    private static final int NOTIF_ID = 1;

    private MediaSession mediaSession;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(NOTIF_ID, buildNotification("DeepSeek Harness 正在运行", "AI 引擎保活中，后台任务持续执行"));
        initMediaSession();
    }

    private void initMediaSession() {
        if (Build.VERSION.SDK_INT < 21) return;
        try {
            mediaSession = new MediaSession(this, "DSH_VoiceSession");
            mediaSession.setCallback(new MediaSession.Callback() {
                private long lastHookTime = 0;

                @Override
                public boolean onMediaButtonEvent(Intent mediaButtonIntent) {
                    if (mediaButtonIntent != null && Intent.ACTION_MEDIA_BUTTON.equals(mediaButtonIntent.getAction())) {
                        KeyEvent event = (KeyEvent) mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                        if (event != null && event.getAction() == KeyEvent.ACTION_DOWN) {
                            int code = event.getKeyCode();
                            if (code == KeyEvent.KEYCODE_HEADSETHOOK ||
                                code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ||
                                code == KeyEvent.KEYCODE_MEDIA_PLAY ||
                                code == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                                
                                long now = System.currentTimeMillis();
                                if (now - lastHookTime > 400) {
                                    lastHookTime = now;
                                    Log.i(TAG, "Bluetooth headset / media button triggered voice wake-up");
                                    VoiceManager.get(EngineService.this).triggerVoiceInteraction();
                                }
                                return true;
                            }
                        }
                    }
                    return super.onMediaButtonEvent(mediaButtonIntent);
                }
            });

            PlaybackState.Builder stateBuilder = new PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE |
                                PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP)
                    .setState(PlaybackState.STATE_PLAYING, 0, 1.0f);
            mediaSession.setPlaybackState(stateBuilder.build());
            mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
            mediaSession.setActive(true);
            Log.i(TAG, "MediaSession for headset buttons initialized");
        } catch (Throwable t) {
            Log.w(TAG, "initMediaSession failed", t);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 每次收到启动/重启意图都刷新通知（系统杀进程后 START_STICKY 重建也会走到这里）
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification("DeepSeek Harness 正在运行", "AI 引擎保活中，后台任务持续执行"));
        // 定时任务自动执行：闹钟到点后带 scheduledTask extra 启动本服务，后台执行任务
        if (intent != null) {
            String task = intent.getStringExtra("scheduledTask");
            if (task != null && !task.isEmpty()) {
                final String fTask = task;
                new Thread(new Runnable() {
                    @Override public void run() {
                        ScheduleExecutor.execute(EngineService.this, fTask);
                    }
                }, "scheduled-exec").start();
            }
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (mediaSession != null) {
            try {
                mediaSession.setActive(false);
                mediaSession.release();
                mediaSession = null;
            } catch (Throwable ignored) {}
        }
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIF_ID);
    }

    private Notification buildNotification(String title, String text) {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        // v1.33：常驻通知里的「控制台」按钮**已移除**。
        // 旧实现把它当成控制台的唯一入口（见旧注释），所以必须有；现在界面上有一个
        // 可拖动的齿轮按钮（MainActivity.attachSettingsFab），通知栏不再承担入口职责，
        // 这一格就只做「前台保活 + 点一下回到应用」这件本分事。
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        return b.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentIntent(pi)
                .setOngoing(true)   // 常驻不可滑动删除
                .setPriority(Notification.PRIORITY_LOW)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "引擎保活",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("DeepSeek Harness 引擎运行状态");
            nm.createNotificationChannel(ch);
        }
    }
}
