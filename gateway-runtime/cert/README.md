# Gateway TLS Certificate Directory

When `GSDK_USE_SSL=true` in your `.env`, place the Suprema gateway's CA certificate here:

- `ca.crt` — Certificate Authority root cert from your Suprema gateway

For TLS-disabled mode (`GSDK_USE_SSL=false`, the default), this directory can be empty.

See `GSDK-Integration-Guide.md` for full TLS setup instructions.
