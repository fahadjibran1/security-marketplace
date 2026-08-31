## Company Web Dashboard Deployment

The company dashboard can now be exported as a static web bundle from:

`C:\Users\Admin\security-marketplace\security-mobile-app`

### 1. Generate the web build

```powershell
Set-Location "C:\Users\Admin\security-marketplace\security-mobile-app"
cmd /c npm run export:web
```

The production-ready files are created in:

`C:\Users\Admin\security-marketplace\security-mobile-app\dist`

### 2. Upload the build to Hetzner

Example PowerShell command:

```powershell
scp -r "C:\Users\Admin\security-marketplace\security-mobile-app\dist\*" root@46.225.214.186:/var/www/dashboard.observantsecurity.co.uk/
```

### 3. Create the dashboard web root on Hetzner

```bash
mkdir -p /var/www/dashboard.observantsecurity.co.uk
chown -R www-data:www-data /var/www/dashboard.observantsecurity.co.uk
```

### 4. Add the Nginx site

Create:

`/etc/nginx/sites-available/security-dashboard`

```nginx
server {
    listen 80;
    server_name dashboard.observantsecurity.co.uk;

    root /var/www/dashboard.observantsecurity.co.uk;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Enable it:

```bash
ln -s /etc/nginx/sites-available/security-dashboard /etc/nginx/sites-enabled/security-dashboard
nginx -t
systemctl reload nginx
certbot --nginx -d dashboard.observantsecurity.co.uk
```

### 5. Add DNS

Point this subdomain to your Hetzner server:

- `dashboard.observantsecurity.co.uk` -> `46.225.214.186`

### Notes

- The web dashboard uses the same live API at `https://api.observantsecurity.co.uk`.
- Rebuild and re-upload the `dist` folder whenever you update the dashboard UI.
- This is currently the company/admin browser experience. The guard flow should remain focused on mobile.
