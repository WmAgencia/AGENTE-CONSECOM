package com.consecom.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VyntraAlarmPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
