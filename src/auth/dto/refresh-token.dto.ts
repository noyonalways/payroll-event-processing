import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Body shared by the refresh and logout endpoints — both consume one token. */
export class RefreshTokenDto {
  @ApiProperty({
    description: 'The refresh token issued by register/login/refresh.',
  })
  @IsString()
  @MinLength(1, { message: 'refreshToken must not be empty' })
  @MaxLength(512)
  refreshToken!: string;
}
