package com.consecom.mobile;

import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.List;

/**
 * Plugin nativo "VyntraAlarm":
 * - Agendamento exato de alarmes de reunião (AlarmManager, Doze-proof)
 * - Cancelamento e listagem
 * - Lista sons nativos (RingtoneManager)
 * - Importa som personalizado (copiado do picker para o app)
 * - Permissão de alarme exato (API 31+: canScheduleExactAlarms / settings)
 */
@CapacitorPlugin(name = "VyntraAlarm")
public class VyntraAlarmPlugin extends Plugin {

    private static final String TAG = "VyntraAlarm";

    // ------------------------------------------------------------------
    // schedule: { id, fireAt (ISO), title, body, soundUri?, volume?, vibrate? }
    // ------------------------------------------------------------------
    @PluginMethod
    public void schedule(PluginCall call) {
        int id = call.getInt("id", -1);
        String fireAt = call.getString("fireAt");
        if (id < 0 || fireAt == null) {
            call.reject("id e fireAt são obrigatórios");
            return;
        }
        long fireAtMs;
        try {
            fireAtMs = java.time.Instant.parse(fireAt).toEpochMilli();
        } catch (Exception e) {
            call.reject("fireAt inválido: " + fireAt);
            return;
        }

        JSONObject alarm = new JSONObject();
        try {
            alarm.put(VyntraAlarmStore.ID, id);
            alarm.put(VyntraAlarmStore.FIRE_AT, fireAtMs);
            alarm.put(VyntraAlarmStore.TITLE, call.getString("title", "Reunião agendada"));
            alarm.put(VyntraAlarmStore.BODY, call.getString("body", ""));
            String soundUri = call.getString("soundUri", "");
            alarm.put(VyntraAlarmStore.SOUND_URI, soundUri == null ? "" : soundUri);
            alarm.put(VyntraAlarmStore.VOLUME, call.getInt("volume", 80));
            alarm.put(VyntraAlarmStore.VIBRATE, call.getBoolean("vibrate", true));
        } catch (Exception e) {
            call.reject("erro ao montar alarme", e);
            return;
        }

        new VyntraAlarmStore(getContext()).save(alarm);
        VyntraAlarmScheduler.schedule(getContext(), id, fireAtMs);
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Integer id = call.getInt("id", null);
        if (id == null) {
            call.reject("id é obrigatório");
            return;
        }
        VyntraAlarmScheduler.cancel(getContext(), id);
        new VyntraAlarmStore(getContext()).remove(id);
        call.resolve();
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        VyntraAlarmStore store = new VyntraAlarmStore(getContext());
        for (JSONObject o : store.all()) {
            VyntraAlarmScheduler.cancel(getContext(), o.optInt(VyntraAlarmStore.ID));
            store.remove(o.optInt(VyntraAlarmStore.ID));
        }
        call.resolve();
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        VyntraAlarmStore store = new VyntraAlarmStore(getContext());
        JSArray arr = new JSArray();
        for (JSONObject o : store.all()) {
            try {
                arr.put(new JSObject(o.toString()));
            } catch (Exception ignored) {
            }
        }
        JSObject res = new JSObject();
        res.put("alarms", arr);
        call.resolve(res);
    }

    // ------------------------------------------------------------------
    // Sons nativos (alarmes e notificações do sistema)
    // ------------------------------------------------------------------
    @PluginMethod
    public void getAlarmSounds(PluginCall call) {
        JSArray out = new JSArray();
        RingtoneManager rm = new RingtoneManager(getContext());
        rm.setType(RingtoneManager.TYPE_ALARM);
        Cursor cursor = rm.getCursor();
        try {
            while (cursor.moveToNext()) {
                String title = cursor.getString(RingtoneManager.TITLE_COLUMN_INDEX);
                Uri uri = rm.getRingtoneUri(cursor.getPosition());
                if (uri == null) continue;
                JSObject o = new JSObject();
                o.put("name", title);
                o.put("uri", uri.toString());
                out.put(o);
            }
        } finally {
            cursor.close();
        }
        JSObject res = new JSObject();
        res.put("sounds", out);
        call.resolve(res);
    }

    /**
     * importSound: grava um áudio no diretório do app (filesDir/sounds).
     * Aceita `data` como data URI base64 (ex: data:audio/mp3;base64,...) —
     * é o que o `<input type="file">` do WebView entrega via FileReader.
     * body: { data, fileName }
     */
    @PluginMethod
    public void importSound(PluginCall call) {
        String data = call.getString("data");
        String fileName = call.getString("fileName", "meu-som.mp3");
        if (data == null) {
            call.reject("data (data URI) é obrigatória");
            return;
        }
        try {
            // Decodifica data URI: data:<mime>;base64,<bytes>
            int comma = data.indexOf(',');
            if (comma < 0) {
                call.reject("data URI inválida");
                return;
            }
            String base64 = data.substring(comma + 1);
            byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);

            File soundsDir = new File(getContext().getFilesDir(), "sounds");
            if (!soundsDir.exists()) soundsDir.mkdirs();
            String safeName = fileName.replaceAll("[^a-zA-Z0-9._-]", "_");
            File out = new File(soundsDir, safeName);

            FileOutputStream fos = new FileOutputStream(out);
            fos.write(bytes);
            fos.close();

            JSObject res = new JSObject();
            res.put("uri", Uri.fromFile(out).toString());
            call.resolve(res);
        } catch (Exception e) {
            Log.e(TAG, "importSound", e);
            call.reject("erro ao importar som", e);
        }
    }

    /** Lista sons personalizados já importados (filesDir/sounds). */
    @PluginMethod
    public void getImportedSounds(PluginCall call) {
        JSArray out = new JSArray();
        File soundsDir = new File(getContext().getFilesDir(), "sounds");
        File[] files = soundsDir.listFiles();
        if (files != null) {
            for (File f : files) {
                JSObject o = new JSObject();
                o.put("name", f.getName());
                o.put("uri", Uri.fromFile(f).toString());
                out.put(o);
            }
        }
        JSObject res = new JSObject();
        res.put("sounds", out);
        call.resolve(res);
    }

    // ------------------------------------------------------------------
    // Permissão de alarme exato (API 31+)
    // ------------------------------------------------------------------
    @PluginMethod
    public void isExactAlarmAllowed(PluginCall call) {
        JSObject res = new JSObject();
        res.put("allowed", canScheduleExactAlarms(getContext()));
        call.resolve(res);
    }

    @PluginMethod
    public void requestExactAlarmPermission(PluginCall call) {
        if (canScheduleExactAlarms(getContext())) {
            call.resolve();
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                        Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            } catch (Exception e) {
                // tenta abrir as configurações do app genéricas
                try {
                    Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getContext().getPackageName()));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(intent);
                } catch (Exception ex) {
                    call.reject("não foi possível abrir as configurações de alarme", ex);
                    return;
                }
            }
        }
        call.resolve();
    }

    private static boolean canScheduleExactAlarms(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }
}
