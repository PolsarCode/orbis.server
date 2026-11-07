import { applyDecorators } from '@nestjs/common';
import {
  IsInt,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  type ValidationOptions,
} from 'class-validator';
import { MAX_INT } from '../communities/community-member.guard';
import { SPOILER_MAX } from './spoiler';

export const IsId = (options?: ValidationOptions) =>
  applyDecorators(Max(MAX_INT, options), Min(1, options), IsInt(options));

export const IsLinkUrl = () =>
  applyDecorators(
    IsUrl({ protocols: ['http', 'https'], require_protocol: true }),
    MaxLength(2048),
  );

export const IsSpoiler = () =>
  applyDecorators(MaxLength(SPOILER_MAX), IsString());
