SUPPORT BRIDGE  -  setup (Windows PC)
=====================================

Ei folder WhatsApp (QR login) ar Alimail (SMTP/IMAP) ke tomar Apps Script portal er sathe jure.
PC on hole nijei chalu hoy, ar kono message hariye jay na.

1) EKBAR SETUP
   a) Node.js 18+ install koro: https://nodejs.org
   b) Apps Script e Deploy > Web app korar por /exec URL pabe. Script Properties e API_KEY ache.
   c) start.bat e double click koro.
      Prothombar config.json khulbe. Duita value boshao, save koro:
         "APPS_SCRIPT_URL": "https://script.google.com/macros/s/....../exec"
         "API_KEY": "Script Properties er API_KEY"
      Abar start.bat e double click koro. Packages auto install hobe (prothombar kichu minute).
   d) (optional, kintu recommended) ngrok:
         - https://ngrok.com e free account, ngrok.exe ei folder e rakho (ba PATH e rakho)
         - ekbar:  ngrok config add-authtoken <TOKEN>
         - ngrok dashboard e free static domain nile config.json e "NGROK_DOMAIN" e boshao.
      ngrok chalu thakle bridge nijei Apps Script e notun URL (BRIDGE_URL) jani die dey.
      VPS/hosting e chalale ngrok lagbe na, config.json e "PUBLIC_URL" e domain dao.

2) WHATSAPP LOGIN (ekbar)
   open-qr.bat e double click > browser e QR ashbe > phone e WhatsApp >
   Linked devices > Link a device > scan. Status "connected" hole done.
   Login wa_session folder e save thake, abar scan lagbe na.

3) PC ON HOLE AUTO START
   install-autostart.bat e double click. Eta Windows e sign-in korar sathe sathe bridge ke
   background e (hidden) chalu kore dey. Bondho korte: uninstall-autostart.bat.
   Note: Windows startup shudhu sign-in er por chalu hoy. PC restart er por nijei chalu rakhte chaile
   Windows auto-login on rakho, ar PC er Sleep off kore dao (Power settings > Sleep: Never).

4) DINE-DINE
   start.bat        bridge chalu kore (crash korle nijei restart hoy)
   stop.bat         bridge bondho kore
   open-qr.bat      WhatsApp QR / status page kholo
   logs\bridge.log  ki hocche dekhte

5) TEST (phone chhara)
   Browser e kholo:  http://localhost:3000/test?key=<API_KEY>
   Agent Portal e ekta "Bridge Test" chat ashle bridge > portal pipeline thik ache.

KI KI SURAKKHA ACHE
   - Internet / Apps Script / PC bondho thakleo message data\queue.json e joma thake, chalu hole pathay.
   - WhatsApp disconnect ba hang hole nijei reconnect kore.
   - PC off thakar somoyer WhatsApp message (shorbocho 3 din) PC on hole auto import hoy.
   - Mail IMAP IDLE e instant ashe. Connection kete gele nijei abar connect hoy.
   - Same message duibar ashle ekbar-i dekhay.
   - LIVE PUSH: bridge message pawar sathe sathe portal ke jani die dey, portal 1-2 second e refresh hoy
     (10 second por por poll korar jonno ar wait kora lage na). Er jonno Apps Script e BRIDGE_URL set thakte hobe;
     ngrok ba config.json er PUBLIC_URL thakle bridge eta nijei set kore.
   - Ek message er jonno portal 8 bar reject korle data\failed.json e rakhe, baki message atke na.

SEEMABOddHOTA
   - WhatsApp media (chhobi/audio/file) ar mail attachment portal e file hishebe ashe (shorbocho 10 MB, ar bishi hole "file too large" likha dekhay).
   - WhatsApp Web unofficial: onek beshi message pathale WhatsApp account restrict korte pare.
