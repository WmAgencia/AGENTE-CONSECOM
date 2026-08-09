package com.consecom.mobile;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * Registro persistente dos alarmes de reunião.
 * Necessário para restaurar os alarmes após reboot (VyntraBootReceiver).
 */
public final class VyntraAlarmStore {

    private static final String PREFS = "vyntra_alarms_v1";
    private static final String KEY = "alarms";

    public static final String ID = "id";
    public static final String FIRE_AT = "fireAt";
    public static final String TITLE = "title";
    public static final String BODY = "body";
    public static final String SOUND_URI = "soundUri";
    public static final String VOLUME = "volume";
    public static final String VIBRATE = "vibrate";
    public static final String EXTRA = "extra";

    private final SharedPreferences prefs;

    public VyntraAlarmStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public synchronized void save(JSONObject alarm) {
        List<JSONObject> all = all();
        int id = alarm.optInt(ID);
        Iterator<JSONObject> it = all.iterator();
        while (it.hasNext()) {
            if (it.next().optInt(ID) == id) it.remove();
        }
        all.add(alarm);
        write(all);
    }

    public synchronized void remove(int id) {
        List<JSONObject> all = all();
        Iterator<JSONObject> it = all.iterator();
        while (it.hasNext()) {
            if (it.next().optInt(ID) == id) it.remove();
        }
        write(all);
    }

    public synchronized List<JSONObject> all() {
        List<JSONObject> out = new ArrayList<>();
        String raw = prefs.getString(KEY, "[]");
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) out.add(arr.getJSONObject(i));
        } catch (JSONException ignored) {
        }
        return out;
    }

    private void write(List<JSONObject> alarms) {
        JSONArray arr = new JSONArray();
        for (JSONObject o : alarms) arr.put(o);
        prefs.edit().putString(KEY, arr.toString()).apply();
    }
}
