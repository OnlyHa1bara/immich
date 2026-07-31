import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { AssetResponseDto, mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { BaseService } from 'src/services/base.service.js';

@Injectable()
export class ViewService extends BaseService {
  private readonly cache = new Map<string, { paths: string[]; expiresAt: number }>();

  private static readonly CACHE_TTL_MS = 10 * 60 * 1000;

  async getUniqueOriginalPaths(auth: AuthDto): Promise<string[]> {
    const cached = this.cache.get(auth.user.id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.paths;
    }

    const paths = await this.viewRepository.getUniqueOriginalPaths(auth.user.id);
    this.cache.set(auth.user.id, { paths, expiresAt: Date.now() + ViewService.CACHE_TTL_MS });
    return paths;
  }

  private invalidate(userId: string) {
    this.cache.delete(userId);
  }

  @OnEvent({ name: 'AssetCreate', server: true })
  onAssetCreate({ asset: { ownerId } }: ArgOf<'AssetCreate'>) {
    this.invalidate(ownerId);
  }

  @OnEvent({ name: 'AssetHide', server: true })
  onAssetHide({ userId }: ArgOf<'AssetHide'>) {
    this.invalidate(userId);
  }

  @OnEvent({ name: 'AssetShow', server: true })
  onAssetShow({ userId }: ArgOf<'AssetShow'>) {
    this.invalidate(userId);
  }

  @OnEvent({ name: 'AssetTrash', server: true })
  onAssetTrash({ userId }: ArgOf<'AssetTrash'>) {
    this.invalidate(userId);
  }

  @OnEvent({ name: 'AssetDelete', server: true })
  onAssetDelete({ userId }: ArgOf<'AssetDelete'>) {
    this.invalidate(userId);
  }

  @OnEvent({ name: 'AssetTrashAll', server: true })
  onAssetTrashAll({ userId }: ArgOf<'AssetTrashAll'>) {
    this.invalidate(userId);
  }

  @OnEvent({ name: 'AssetDeleteAll', server: true })
  onAssetDeleteAll({ userId }: ArgOf<'AssetDeleteAll'>) {
    this.invalidate(userId);
  }

  @OnEvent({ name: 'AssetRestoreAll', server: true })
  onAssetRestoreAll({ userId }: ArgOf<'AssetRestoreAll'>) {
    this.invalidate(userId);
  }

  async getAssetsByOriginalPath(auth: AuthDto, path: string): Promise<AssetResponseDto[]> {
    const assets = await this.viewRepository.getAssetsByOriginalPath(auth.user.id, path);
    return assets.map((asset) => mapAsset(asset, { auth }));
  }
}
