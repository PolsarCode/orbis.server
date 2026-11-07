import { Body, Controller, Put, UseGuards } from '@nestjs/common';
import { LikeResult, LikesService } from './likes.service';
import { LikeDto } from './dto/like.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { UserId } from '../common/user-id';

@Controller('likes')
@UseGuards(JwtAuthGuard)
export class LikesController {
  constructor(private readonly likesService: LikesService) {}

  @Put()
  setLike(
    @UserId() userId: number,
    @Body() likeDto: LikeDto,
  ): Promise<LikeResult> {
    return this.likesService.setLike(userId, likeDto);
  }
}
