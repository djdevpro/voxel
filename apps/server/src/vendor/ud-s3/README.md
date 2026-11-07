# `@ud/s3`, the S3 engine of S3 Drive

These files are the S3 engine of [S3 Drive](https://github.com/djdevpro/s3drive) (`packages/s3/src`, commit `524a69f`), reused as they are by the large attachments of Voxel (`../../files`). It gives presigned GET and PUT with a signed `Content-Length`, object HEAD and delete, prefix sizes, error codes and an SSRF guard with pinned DNS resolution.

The only change: `errors.ts` and `types.ts` import `./contracts.js`, the few error types and statuses of `@ud/contracts` written without zod, instead of `@ud/contracts`.

To update, copy `packages/s3/src/*.ts` again and repeat that change.
