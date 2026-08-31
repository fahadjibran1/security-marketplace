# Download Site

Static pilot download page for `download.observantsecurity.co.uk`.

## Expected server layout

```text
/var/www/download.observantsecurity.co.uk/
  index.html
  styles.css
  app/
    observant-security-pilot.apk
```

## Basic deploy

Copy this folder to the server web root, then upload the latest Android pilot APK into:

```text
app/observant-security-pilot.apk
```

The main CTA button on the page already points to that file.
