---
name: image-uploads
description: Handle image uploads on the Orbis server through the shared storage service. Use when adding or changing an endpoint that accepts an uploaded image, or code that replaces or removes a stored image.
---

# Image Uploads

Every uploaded image goes through `StorageService.uploadImage` (`src/storage/storage.service.ts`), never a direct `PutObjectCommand`. It rejects files over 10 MB (`IMAGE_MAX_BYTES`), fixes the orientation, shrinks the image to fit a maximum size without enlarging it, and converts it to WebP, so nothing is stored as uploaded.

## Workflow

1. Use `FileInterceptor('file', { limits: { fileSize: IMAGE_MAX_BYTES } })` on the route.
2. Call `StorageService.uploadImage` with a `maxSize` that fits where the image is shown. Current sizes: avatars 384, community icons 512, covers 1600, backgrounds 1920.
3. Use a folder named for the image's purpose, for example `avatars` or `user-covers`.
4. When an image is replaced or removed, delete the old file with `StorageService.deleteUrl`, which finds its key with `keyFor` and deletes it with `StorageService.delete`.
