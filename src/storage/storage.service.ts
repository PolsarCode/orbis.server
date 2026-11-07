import { BadRequestException, Injectable } from '@nestjs/common';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import sharp = require('sharp');
import { createS3Client } from './s3';

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export type StoredFile = {
  key: string;
  url: string;
};

@Injectable()
export class StorageService {
  private readonly client = createS3Client();
  private readonly bucket = process.env.BUCKET_NAME!;
  private readonly publicUrl = process.env.STORAGE_PUBLIC_URL!;

  async uploadImage(
    file: Buffer,
    folder: string,
    maxSize = 2048,
  ): Promise<StoredFile> {
    if (file.length > IMAGE_MAX_BYTES) {
      throw new BadRequestException('Image must be 10 MB or smaller');
    }

    const body = await this.toWebp(file, maxSize);
    const key = `${folder}/${randomUUID()}.webp`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    return { key, url: this.urlFor(key) };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async deleteUrl(url: string | null): Promise<void> {
    const key = url && this.keyFor(url);
    if (key) await this.delete(key).catch(() => {});
  }

  urlFor(key: string): string {
    return `${this.publicUrl}/${key}`;
  }

  keyFor(url: string): string | null {
    const prefix = `${this.publicUrl}/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : null;
  }

  private async toWebp(file: Buffer, maxSize: number): Promise<Buffer> {
    try {
      return await sharp(file)
        .rotate()
        .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, effort: 6, smartSubsample: true })
        .toBuffer();
    } catch {
      throw new BadRequestException('File is not a supported image');
    }
  }
}
