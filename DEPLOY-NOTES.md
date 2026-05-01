# Production deployment notes

## Reverse proxy JSON body size

Express parses JSON request bodies up to **`JSON_BODY_LIMIT`** (see [`index.js`](index.js); default **50mb**). Checkout endpoints (`create-payment-intent`, PayPal routes, `checkout-draft` PATCH, etc.) may receive large `items[].designSnapshot` payloads containing base64-encoded images before they are written to disk and replaced with upload IDs server-side.

Configure nginx or your edge proxy so **`client_max_body_size`** (or equivalent) is **at least** as large as `JSON_BODY_LIMIT`. Example:

```nginx
client_max_body_size 50m;
```

If the proxy rejects the body before it reaches Node, clients may see **413** or HTML error pages instead of JSON.

## Upload files on disk

Design images are stored under the process `uploads/` directory (same as multipart uploads). Ensure persistent volume / backups if required for fulfillment.
