package com.consecom.mobile;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.util.List;

/**
 * Agendador nativo de alarmes de reunião usando AlarmManager.
 * - setAlarmClock: o alarme aparece na interface nativa de relógio do Android
 *   (status bar + tela de bloqueio "Próximo alarme") e tem garantia máxima de
 *   disparo — funciona em Doze, com o app fechado e sem depender da permissão
 *   de alarme exato (API 31+).
 * - registra no VyntraAlarmStore para restaurar após reboot
 * - cada alarme vira um BroadcastReceiver (VyntraAlarmReceiver)
 */
public final class VyntraAlarmScheduler {

    private static final String TAG = "VyntraAlarm";

    private VyntraAlarmScheduler() {
    }

    public static PendingIntent buildPendingIntent(Context context, int id) {
        Intent intent = new Intent(context, VyntraAlarmReceiver.class);
        intent.setAction("com.consecom.mobile.ALARM_" + id);
        intent.putExtra(VyntraAlarmStore.ID, id);
        return PendingIntent.getBroadcast(
                context, id, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    public static void schedule(Context context, int id, long fireAtMs) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = buildPendingIntent(context, id);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // Relógio nativo: mostra "Próximo alarme HH:MM" na barra de status /
            // tela de bloqueio e dispara com prioridade máxima (Doze-proof).
            AlarmManager.AlarmClockInfo info = new AlarmManager.AlarmClockInfo(fireAtMs, pi);
            am.setAlarmClock(info, pi);
        } else {
            am.setExact(AlarmManager.RTC_WAKEUP, fireAtMs, pi);
        }
        Log.d(TAG, "schedule id=" + id + " fireAt=" + fireAtMs);
    }

    public static void cancel(Context context, int id) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        am.cancel(buildPendingIntent(context, id));
        Log.d(TAG, "cancel id=" + id);
    }

    /** Reagenda todos os alarmes persistidos (após reboot). */
    public static void restoreAfterBoot(Context context) {
        VyntraAlarmStore store = new VyntraAlarmStore(context);
        List<JSONObject> alarms = store.all();
        long now = System.currentTimeMillis();
        for (JSONObject alarm : alarms) {
            try {
                long fireAt = alarm.optLong(VyntraAlarmStore.FIRE_AT);
                int id = alarm.optInt(VyntraAlarmStore.ID);
                if (fireAt > now) {
                    schedule(context, id, fireAt);
                    Log.d(TAG, "restored id=" + id + " fireAt=" + fireAt);
                } else {
                    store.remove(id);
                }
            } catch (Exception e) {
                Log.e(TAG, "restore falhou para alarme", e);
            }
        }
    }
}
