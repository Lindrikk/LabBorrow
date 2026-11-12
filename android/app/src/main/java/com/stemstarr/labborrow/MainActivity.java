package com.stemstarr.labborrow;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * STEM STARR LabBorrow for Android: shows the LabBorrow web app full screen.
 *
 * The lab laptop's public link changes every time it restarts, so the laptop publishes
 * the current link to server-url.txt in the GitHub repo (see start-public.ps1) and this
 * app reads it on every launch. Students never have to type the link.
 */
public class MainActivity extends Activity {

    private static final String[] LINK_SOURCES = {
        "https://api.github.com/repos/Lindrikk/LabBorrow/contents/server-url.txt", // updates within seconds
        "https://raw.githubusercontent.com/Lindrikk/LabBorrow/main/server-url.txt", // fallback, cached ~5 min
    };
    private static final int REQ_CAMERA = 1;
    private static final int REQ_FILE = 2;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private SharedPreferences prefs;
    private String serverUrl;
    private PermissionRequest pendingPermission;
    private ValueCallback<Uri[]> fileCallback;
    private AlertDialog offlineDialog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("labborrow", MODE_PRIVATE);
        web = new WebView(this);
        setContentView(web);
        setUpWebView();
        showMessage("Connecting to LabBorrow…");
        findServerAndLoad();
    }

    private void setUpWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // the camera preview plays without a tap
        s.setAllowFileAccess(false);
        CookieManager.getInstance().setAcceptCookie(true); // keeps students logged in

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri target = request.getUrl();
                if (serverUrl != null && target.getHost() != null
                        && target.getHost().equals(Uri.parse(serverUrl).getHost())) {
                    return false; // LabBorrow pages stay in the app
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, target)); // other links open in the browser
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline();
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                // Cloudflare answers 502/530 when the laptop or its tunnel is off
                if (request.isForMainFrame() && response.getStatusCode() >= 500) showOffline();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                main.post(() -> {
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.getResources());
                    } else {
                        pendingPermission = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                // "Use a photo" / "Add photos" buttons
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQ_CAMERA && pendingPermission != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                pendingPermission.grant(pendingPermission.getResources());
            } else {
                pendingPermission.deny();
            }
            pendingPermission = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ------------------------------------------------------------ finding the server

    private void findServerAndLoad() {
        new Thread(() -> {
            String published = fetchPublishedLink();
            main.post(() -> {
                if (published != null) prefs.edit().putString("server_url", published).apply();
                String url = published != null ? published : prefs.getString("server_url", null);
                if (url == null) askForLink(false);
                else load(url);
            });
        }).start();
    }

    private String fetchPublishedLink() {
        for (String source : LINK_SOURCES) {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(source).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestProperty("Accept", "application/vnd.github.raw");
                c.setRequestProperty("Cache-Control", "no-cache");
                c.setRequestProperty("User-Agent", "LabBorrow-Android");
                if (c.getResponseCode() == 200) {
                    String link = clean(read(c.getInputStream()));
                    if (link != null) return link;
                }
            } catch (Exception ignored) { }
        }
        return null;
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[1024];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        in.close();
        return out.toString(StandardCharsets.UTF_8.name());
    }

    /** Accepts "https://..." links only; adds https:// if it was left out. */
    private static String clean(String text) {
        if (text == null) return null;
        String t = text.trim();
        if (t.isEmpty()) return null;
        if (!t.startsWith("http://") && !t.startsWith("https://")) t = "https://" + t;
        if (!t.startsWith("https://")) return null;
        while (t.endsWith("/")) t = t.substring(0, t.length() - 1);
        return t;
    }

    private void load(String url) {
        serverUrl = url;
        web.loadUrl(url);
    }

    // ------------------------------------------------------------ messages and dialogs

    private void showMessage(String message) {
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
            + "<body style='margin:0;font-family:sans-serif;background:#f4f6f5;color:#14211f;"
            + "display:flex;align-items:center;justify-content:center;height:100vh;text-align:center'>"
            + "<div><div style='font-size:22px;font-weight:700;color:#02403b'>LabBorrow</div>"
            + "<div style='font-size:12px;letter-spacing:.1em;color:#5a6866;margin:4px 0 18px'>STEM STARR · AAMNHS</div>"
            + "<div style='font-size:15px'>" + message + "</div></div></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void showOffline() {
        if (isFinishing() || (offlineDialog != null && offlineDialog.isShowing())) return;
        showMessage("Not connected");
        offlineDialog = new AlertDialog.Builder(this)
            .setTitle("Can't reach LabBorrow")
            .setMessage("The laboratory laptop that runs LabBorrow may be off, or its link changed. "
                + "Check your internet connection, then try again.")
            .setPositiveButton("Retry", (d, w) -> {
                showMessage("Connecting to LabBorrow…");
                findServerAndLoad();
            })
            .setNeutralButton("Enter link", (d, w) -> askForLink(true))
            .setCancelable(false)
            .show();
    }

    private void askForLink(boolean cancelable) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://….trycloudflare.com");
        String saved = prefs.getString("server_url", "");
        input.setText(saved);
        AlertDialog.Builder b = new AlertDialog.Builder(this)
            .setTitle("LabBorrow server link")
            .setMessage("Type the link shown on the laboratory laptop.")
            .setView(input)
            .setPositiveButton("Open", (d, w) -> {
                String link = clean(input.getText().toString());
                if (link == null) {
                    askForLink(cancelable);
                    return;
                }
                prefs.edit().putString("server_url", link).apply();
                load(link);
            })
            .setCancelable(cancelable);
        if (cancelable) b.setNegativeButton("Cancel", null);
        b.show();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle("Exit LabBorrow?")
            .setPositiveButton("Exit", (d, w) -> finish())
            .setNeutralButton("Change server link", (d, w) -> askForLink(true))
            .setNegativeButton("Cancel", null)
            .show();
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }
}
