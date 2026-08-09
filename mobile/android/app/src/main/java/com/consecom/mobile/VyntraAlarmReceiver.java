package com.consecom.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

/**
 * Dispara o alarme de reunião. Acordado pelo AlarmManager mesmo com o app
 * fechado ou em Doze. Cria notificação de alta prioridade (canal de alarme)
 * com o som/vibração/volume configurados para a reunião.
 */
public class VyntraAlarmReceiver extends BroadcastReceiver {

    private static final String TAG = "VyntraAlarm";
    public static final String CHANNEL_ALARM = "vyntra_alarm_channel";

    @Override
    public void onReceive(Context context, Intent intent) {
        int id = intent.getIntExtra(VyntraAlarmStore.ID, -1);
        VyntraAlarmStore store = new VyntraAlarmStore(context);
        JSONObject alarm = null;
        for (JSONObject o : store.all()) {
            if (o.optInt(VyntraAlarmStore.ID) == id) {
                alarm = o;
                break;
            }
        }
        if (alarm == null) {
            Log.w(TAG, "alarme não encontrado no store: id=" + id);
            return;
        }

        store.remove(id);

        String title = alarm.optString(VyntraAlarmStore.TITLE, "Reunião agendada");
        String body = alarm.optString(VyntraAlarmStore.BODY, "");
        String soundUri = alarm.optString(VyntraAlarmStore.SOUND_URI, "");
        int volume = alarm.optInt(VyntraAlarmStore.VOLUME, 80);
        boolean vibrate = alarm.optBoolean(VyntraAlarmStore.VIBRATE, true);

        fireAlarm(context, id, title, body, soundUri, volume, vibrate);
    }

    public static void fireAlarm(Context context, int id, String title, String body,
                                 String soundUri, int volume, boolean vibrate) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ALARM, "Alarme de reunião",
                    NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Toque para reuniões agendadas (soa mesmo em modo silencioso)");
            channel.enableVibration(vibrate);
            channel.setBypassDnd(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                channel.setAllowBubbles(false);
            }
            Uri sound = soundUri != null && !soundUri.isEmpty()
                    ? Uri.parse(soundUri)
                    : RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (sound != null) {
                channel.setSound(sound, new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
            }
            nm.createNotificationChannel(channel);
        }

        Intent appIntent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent contentIntent = null;
        if (appIntent != null) {
            appIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            contentIntent = PendingIntent.getActivity(
                    context, id, appIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(context, CHANNEL_ALARM);
        } else {
            builder = new Notification.Builder(context);
            builder.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM));
            builder.setVibrate(vibrate ? new long[]{0, 400, 200, 400} : null);
        }

        builder.setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setAutoCancel(true)
                .setContentIntent(contentIntent)
                .setPriority(Notification.PRIORITY_MAX)
                .setCategory(Notification.CATEGORY_ALARM);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            builder.setVisibility(Notification.VISIBILITY_PUBLIC);
            builder.setColor(Color.parseColor("#0a0a0f"));
        }

        nm.notify(id, builder.build());
    }
}
