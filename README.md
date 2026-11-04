![Voxel, a modern webmail with a built-in AI assistant](.github/banner.png)

A modern webmail: fast, installable, works offline, and handles several mailboxes at once.

It talks to JMAP servers such as [Stalwart](https://stalw.art) straight from the browser, and to any IMAP/SMTP mailbox through a small gateway.

Its built-in AI assistant searches your mail, helps you write and sends you a daily summary. It runs in the browser with your own provider (any OpenAI-compatible API such as Ollama or vLLM, or Anthropic); keys stay encrypted on your device.

## Run

```sh
cp config.example.json config.json   # map your mail domains to their JMAP server
VOXEL_HOST=webmail.example.com docker compose up -d --build
```

The JMAP server must allow the webmail's origin (CORS).

## Develop

Node 24 or later.

```sh
npm install
npm run dev:web    # http://localhost:5273
npm run dev:demo   # demo mailboxes and a simulated AI, no server needed: sign in as alex@acme.demo / demo
npm test
```

## License

[MIT](LICENSE)
