# work-fold bridge

This directory is the minimal public HTTPS entrypoint used to establish the
Railway project and custom domain. It deliberately implements only `/` and
`/health`; it is not yet the production hosted runtime described by the App
platform foundation.

Run it locally with:

```bash
npm start
```

Deploy only this directory with:

```bash
npm run railway -- up services/bridge --path-as-root --service bridge
```
