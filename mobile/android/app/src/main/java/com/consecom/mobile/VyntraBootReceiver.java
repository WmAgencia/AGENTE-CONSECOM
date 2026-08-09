package com.consecom.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Restaura os alarmes de reunião após o reboot do aparelho (BOOT_COMPLETED)
 * e após atualização do app (MY_PACKAGE_REPLACED), lendo o VyntraAlarmStore.
 */
public class VyntraBootReceiver extends BroadcastReceiver {

    private static final String TAG = "VyntraAlarm";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) return;

        boolean boot = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action);
        if (!boot) return;

        Log.d(TAG, "boot/replace detectado — restaurando alarmes");
        VyntraAlarmScheduler.restoreAfterBoot(context);
    }
}
