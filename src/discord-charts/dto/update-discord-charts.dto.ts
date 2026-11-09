import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateDiscordChartsDto {
  @IsOptional()
  @IsBoolean()
  sendAnime?: boolean;

  @IsOptional()
  @IsBoolean()
  sendManga?: boolean;

  @IsOptional()
  @IsBoolean()
  sendGames?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string | null;
}
