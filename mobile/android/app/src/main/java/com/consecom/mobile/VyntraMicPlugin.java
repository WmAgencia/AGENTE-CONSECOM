package com.consecom.mobile;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;

import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.util.ArrayList;
import java.util.Locale;

/**
 * Plugin nativo "VyntraMic": mensagem de voz real para o chat da IA.
 *
 * Grava o áudio com MediaRecorder (arquivo .m4a real) e, EM PARALELO, roda o
 * reconhecimento de fala do Android (SpeechRecognizer / serviços do Google)
 * para transcrever o que foi dito ao vivo. Ao soltar, o texto transcrito é
 * enviado ao chat da IA e o arquivo de áudio fica salvo/reproduzível.
 *
 * Sem nenhum serviço de STT externo — tudo no aparelho.
 */
@CapacitorPlugin(
    name = "VyntraMic",
    permissions = {
        @Permission(alias = "recordAudio", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class VyntraMicPlugin extends Plugin {

    private static final String TAG = "VyntraMic";
    private static final int MIN_RECORD_MS = 300;

    private MediaRecorder recorder;
    private File outputFile;
    private long startedAtMs;
    private HandlerThread recorderThread;
    private Handler recorderHandler;

    private SpeechRecognizer recognizer;
    private boolean speechActive;
    private boolean recording;
    private StringBuilder latestText = new StringBuilder();
    private String lastFinalText = "";
    private boolean startedOnNewRecorderApi = false;

    // ------------------------------------------------------------------
    // Permissão
    // ------------------------------------------------------------------
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        JSObject res = new JSObject();
        res.put("granted", hasRecordPermission());
        res.put("permanentDenied", hasRecordPermission()
                || !getActivity().shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO));
        call.resolve(res);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (hasRecordPermission()) {
            JSObject res = new JSObject();
            res.put("granted", true);
            call.resolve(res);
            return;
        }
        try {
            requestPermissionForAlias("recordAudio", call, "permissionCallback");
        } catch (Exception e) {
            call.reject("falha ao pedir permissão de microfone", e);
        }
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        JSObject res = new JSObject();
        res.put("granted", hasRecordPermission());
        call.resolve(res);
    }

    private boolean hasRecordPermission() {
        return getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    // ------------------------------------------------------------------
    // Gravação + reconhecimento em paralelo
    // ------------------------------------------------------------------
    @PluginMethod
    public void startRecording(PluginCall call) {
        if (!hasRecordPermission()) {
            call.reject("permissão de microfone negada");
            return;
        }
        if (recording) {
            call.reject("já gravando");
            return;
        }

        latestText = new StringBuilder();
        lastFinalText = "";
        recording = true;

        try {
            File dir = new File(getContext().getFilesDir(), "recordings");
            if (!dir.exists()) dir.mkdirs();
            outputFile = new File(dir, "vyntra_" + System.currentTimeMillis() + ".m4a");

            startedAtMs = System.currentTimeMillis();

            // MediaRecorder fora da thread principal
            recorderThread = new HandlerThread("vyntra-recorder");
            recorderThread.start();
            recorderHandler = new Handler(recorderThread.getLooper());
            recorderHandler.post(this::startRecorderSafe);

            // Reconhecimento de fala na main thread
            new Handler(Looper.getMainLooper()).post(this::startSpeechSafe);

            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "startRecording", e);
            recording = false;
            call.reject("falha ao iniciar gravação", e);
        }
    }

    private void startRecorderSafe() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                recorder = new MediaRecorder(getContext());
            } else {
                //noinspection deprecation
                recorder = new MediaRecorder();
            }
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioEncodingBitRate(64000);
            recorder.setAudioSamplingRate(44100);
            recorder.setOutputFile(outputFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
        } catch (Exception e) {
            Log.e(TAG, "startRecorderSafe", e);
            releaseRecorder();
            notifyError("falha ao iniciar o gravador de áudio");
        }
    }

    private void startSpeechSafe() {
        try {
            if (recognizer != null) {
                recognizer.destroy();
            }
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(listener);

            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "pt-BR");
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "pt-BR");
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
            speechActive = true;
            recognizer.startListening(intent);
        } catch (Exception e) {
            Log.e(TAG, "startSpeechSafe", e);
            speechActive = false;
            notifyError("reconhecimento de voz indisponível neste aparelho");
        }
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {
        }

        @Override
        public void onBeginningOfSpeech() {
        }

        @Override
        public void onRmsChanged(float rmsdB) {
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
        }

        @Override
        public void onEndOfSpeech() {
        }

        @Override
        public void onError(int error) {
            speechActive = false;
            switch (error) {
                case SpeechRecognizer.ERROR_NO_MATCH:
                case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                    // Voz não capturada/reconhecida — áudio continua gravando
                    notifyTranscript("", true);
                    break;
                case SpeechRecognizer.ERROR_NETWORK:
                case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                    notifyError("sem conexão para reconhecimento de voz");
                    break;
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                    notifyError("permissão de microfone negada para reconhecimento");
                    break;
                default:
                    notifyError("reconhecimento de voz indisponível");
                    break;
            }
        }

        @Override
        public void onResults(Bundle results) {
            speechActive = false;
            String text = bestResult(results);
            if (text != null && !text.trim().isEmpty()) {
                lastFinalText = text;
            }
            notifyTranscript(lastFinalText, true);
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            String text = bestResult(partialResults);
            if (text != null && !text.trim().isEmpty()) {
                latestText = new StringBuilder(text);
                notifyTranscript(text, false);
            }
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
        }
    };

    private String bestResult(Bundle results) {
        ArrayList<String> matches = results
                .getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null || matches.isEmpty()) return "";
        return matches.get(0);
    }

    // ------------------------------------------------------------------
    // Parar / cancelar
    // ------------------------------------------------------------------
    @PluginMethod
    public void stopRecording(PluginCall call) {
        long durationMs = recording ? System.currentTimeMillis() - startedAtMs : 0;
        File file = outputFile;
        boolean shouldKeep = durationMs >= MIN_RECORD_MS && file != null && file.exists();

        stopBoth();

        if (!shouldKeep) {
            if (file != null && file.exists()) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
            JSObject res = new JSObject();
            res.put("uri", "");
            res.put("durationMs", durationMs);
            res.put("size", 0);
            res.put("text", "");
            res.put("tooShort", true);
            call.resolve(res);
            return;
        }

        String finalText = lastFinalText != null && !lastFinalText.isEmpty()
                ? lastFinalText
                : latestText.toString();

        JSObject res = new JSObject();
        res.put("uri", "file://" + file.getAbsolutePath());
        res.put("durationMs", durationMs);
        res.put("size", file.length());
        res.put("text", finalText);
        res.put("tooShort", false);
        call.resolve(res);
    }

    @PluginMethod
    public void cancelRecording(PluginCall call) {
        stopBoth();
        if (outputFile != null && outputFile.exists()) {
            //noinspection ResultOfMethodCallIgnored
            outputFile.delete();
        }
        outputFile = null;
        call.resolve();
    }

    @PluginMethod
    public void isRecording(PluginCall call) {
        JSObject res = new JSObject();
        res.put("recording", recording);
        call.resolve(res);
    }

    private void stopBoth() {
        releaseRecorder();
        stopSpeech();
        recording = false;
    }

    private void stopSpeech() {
        if (recognizer != null) {
            try {
                recognizer.stopListening();
            } catch (Exception ignored) {
            }
        }
    }

    private void releaseRecorder() {
        if (recorderHandler != null) {
            recorderHandler.post(() -> {
                try {
                    if (recorder != null) {
                        try {
                            recorder.stop();
                        } catch (RuntimeException ignored) {
                            // áudio curto demais (m4a) dispara stop() exception — ok
                        }
                        recorder.release();
                    }
                } catch (Exception e) {
                    Log.e(TAG, "releaseRecorder", e);
                } finally {
                    recorder = null;
                }
            });
        } else {
            recorder = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopBoth();
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
        if (recorderThread != null) {
            recorderThread.quitSafely();
        }
        super.handleOnDestroy();
    }

    // ------------------------------------------------------------------
    // Eventos para o JS
    // ------------------------------------------------------------------
    private void notifyTranscript(String text, boolean isFinal) {
        JSObject data = new JSObject();
        data.put("text", text);
        data.put("isFinal", isFinal);
        notifyListeners("transcript", data, true);
    }

    private void notifyError(String message) {
        JSObject data = new JSObject();
        data.put("message", message);
        notifyListeners("micerror", data, true);
    }
}
