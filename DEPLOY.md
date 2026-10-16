# Deploying LabBorrow on PythonAnywhere

Result: a permanent link `https://<username>.pythonanywhere.com` that students open on their phones.
The `data/` folder (accounts, borrow records, trained AI) lives only on the server and is never
in Git, so updating the code never erases it.

Below, replace `USERNAME` with your PythonAnywhere username and `GITHUB_USER` with your GitHub username.

## 1. Put the code on GitHub (once)

1. Make a free account at https://github.com and create a **new repository** named `LabBorrow`.
   Leave it empty (no README, no .gitignore).
2. On your laptop, in the `LabBorrow` folder:
   ```
   git remote add origin https://github.com/GITHUB_USER/LabBorrow.git
   git branch -M main
   git push -u origin main
   ```
   A browser window asks you to sign in to GitHub the first time.

## 2. Set up PythonAnywhere (once)

1. Make a free **Beginner** account at https://www.pythonanywhere.com.
2. Open **Consoles → Bash** and run:
   ```
   git clone https://github.com/GITHUB_USER/LabBorrow.git
   ```
   (If the repository is private, GitHub asks for a username and a *personal access token*
   instead of a password: GitHub → Settings → Developer settings → Personal access tokens.)
3. Go to the **Web** tab → **Add a new web app** → **Next** → **Manual configuration** → **Python 3.11**.
4. On the Web tab, click the **WSGI configuration file** link (`/var/www/USERNAME_pythonanywhere_com_wsgi.py`),
   delete everything in it and paste:
   ```python
   import os, sys
   os.environ["LAB_ADMIN_PASS"] = "choose-a-strong-password"   # used only when the database is first created
   sys.path.insert(0, "/home/USERNAME/LabBorrow")
   from app import app as application
   ```
   Click **Save**.
5. Back on the Web tab, click **Reload**, then open `https://USERNAME.pythonanywhere.com`.
6. Log in as `admin` with the password you chose, add your items, and train the AI.

Flask is already installed on PythonAnywhere, so you don't need to `pip install` anything.

## 3. Updating the app (every time)

On your laptop:
```
git add -A
git commit -m "Describe what you changed"
git push
```

Then in a PythonAnywhere **Bash console**:
```
cd ~/LabBorrow && git pull && touch /var/www/USERNAME_pythonanywhere_com_wsgi.py
```
Touching the WSGI file reloads the site, the same as clicking **Reload**. Phones get the new
version the next time they open or refresh the app.

## Things to know

- Free web apps are switched off after a while unless you log in and click
  **"Run until 3 months from today"** on the Web tab. The site shows the date.
- Back up `~/LabBorrow/data/` now and then (Files tab → download `labborrow.db` and `model.json`).
- If the site shows an error, check the **error log** link on the Web tab.
