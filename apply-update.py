#!/usr/bin/env python3
"""
CogniFlow update installer.
Run from the folder that contains index.html and cogniflow-engine.js:

    python3 apply-update.py        (Mac / Linux)
    python apply-update.py         (Windows)

It adds one <script> line to index.html, right before </body>, and saves
your original file as index.backup.html first.
"""
import os, shutil, sys

TAG = '<script src="cogniflow-engine.js"></script>'

if not os.path.exists('index.html'):
    sys.exit('index.html not found. Run this from the folder that contains it.')
if not os.path.exists('cogniflow-engine.js'):
    sys.exit('cogniflow-engine.js not found. Put it in the same folder as index.html.')

html = open('index.html', encoding='utf-8').read()

if TAG in html:
    sys.exit('Already installed. Nothing to change.')
if '</body>' not in html:
    sys.exit('Could not find </body> in index.html.')

shutil.copy('index.html', 'index.backup.html')
i = html.rfind('</body>')
html = html[:i] + TAG + '\n\n' + html[i:]
open('index.html', 'w', encoding='utf-8').write(html)
print('Done. Your original was saved as index.backup.html')

