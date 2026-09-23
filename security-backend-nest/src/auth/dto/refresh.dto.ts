import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RefreshDto {
  /**
   * Optional so logout can be called with nothing to revoke (already-cleared client) and still
   * succeed. Length bounds keep an oversized body from reaching the hash.
   */
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  refreshToken?: string;
}
