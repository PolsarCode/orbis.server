import { NotFoundException } from '@nestjs/common';

export function ignoreMissing(error: unknown) {
  if (!(error instanceof NotFoundException)) throw error;
}
