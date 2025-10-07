import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "node:path";
import { randomBytes } from "node:crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // TODO: implement the upload here
  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (file instanceof File) {
    const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_UPLOAD_SIZE) {
      throw new BadRequestError("Thumbnail file exceeds the maximum allowed size of 10MB");
    }
  } else {
    throw new BadRequestError("Thumbnail file missing");
  }
  const mediaType = file.type;
  // if (!mediaType) {
  //   throw new BadRequestError("Missing Content-Type for thumbnail");
  // }
  if ((mediaType !== "image/jpeg") && (mediaType !== "image/png")) {
     throw new BadRequestError("Thumbnail should be image image/jpeg or image/png");
  }

  const data = await file.arrayBuffer();
  if (!data) {
    throw new Error("Error reading file data");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID != userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }


  const ext = mediaType.split("/")[1];
  const fileName = randomBytes(32).toString("base64url");
  const filePath = path.join(cfg.assetsRoot, `${fileName}.${ext}`);
  await Bun.write(filePath, data, { createPath: true });

  videoThumbnails.set(fileName, { data, mediaType });
  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${fileName}.${ext}`;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
