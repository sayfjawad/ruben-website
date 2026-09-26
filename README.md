# ruben-website

Jouw project voor de AI-training. Wat de agent hier bouwt, wordt live gezet op
**https://ruben.sdai.nl**.

## Hoe het werkt
- Alles in deze map draait in jouw container onder `/workspace/ruben-website`.
- Er draait automatisch een dev-server op **poort 3000** (zie `server.js`), die
  nginx doorzet naar `https://ruben.sdai.nl`.
- De **browser-IDE** staat op `https://ide-ruben.sdai.nl`.

## Starten / stoppen van de server
De container start de server automatisch. Wil je hem zelf draaien:

```bash
npm run dev          # = node server.js  (poort 3000)
```

Gebruik je een eigen framework (Vite, Next, Express, …)? Zorg dat het op
`0.0.0.0:3000` luistert, en zet zo nodig de auto-server uit met
`sudo supervisorctl stop appserver`.

## Je werk opslaan (git push)
De container heeft schrijfrechten op deze repo via een deploy-key:

```bash
git add -A
git commit -m "beschrijf je wijziging"
git push
```

Repo: `git@github.com:sayfjawad/ruben-website.git`

## Domein kanhai.it

Deze app is gebrand op **kanhai.it**. Het domein zelf staat nog ergens anders en kan
niet vanuit deze container worden omgezet. Wat er feitelijk is:

| | |
|---|---|
| kanhai.it | wijst naar `185.158.164.59` (+ IPv6), LiteSpeed, bestaande site "Fam KANHAI home", Let's Encrypt wildcard-certificaat `*.kanhai.it` |
| deze app | draait op de workshop-host `158.220.106.157`; het nginx-certificaat daar dekt alleen `*.sdai.nl`, niet kanhai.it |
| nginx | draait op de host, **niet** in deze container — daar is dus geen configuratie mogelijk |

Om kanhai.it naar deze app te laten wijzen is dit nodig, op de host:

1. DNS van kanhai.it (A en AAAA) naar `158.220.106.157`.
2. Een nginx server block voor `kanhai.it` dat naar de container op poort 3000 proxyt.
3. Een TLS-certificaat voor kanhai.it (bijv. certbot) in dat blok.

Let op: zolang stap 1 omgaat, is de bestaande website op kanhai.it niet meer bereikbaar.

Alternatief: de app uitrollen op de hosting van kanhai.it zelf. Dat vereist toegang tot
die server (FTP/SSH/cPanel) en Node-ondersteuning; met een statische export kan het ook.
Deze container heeft geen toegang tot die server — de Qwen-key en `/api/chat` werken daar
alleen als Node daar kan draaien.

