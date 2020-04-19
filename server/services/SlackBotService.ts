import { Service } from "typedi";
import { ImageElement, WebClient } from "@slack/web-api";
import { Config } from "../Config";
import { RoomsService } from "./RoomsService";
import { RoomEvent } from "../express/types/RoomEvent";
import { logger } from "../log";
import { RoomWithParticipants } from "../express/types/RoomWithParticipants";
import { Block, KnownBlock } from "@slack/types";

const LOOP_INTERVAL = 30 * 1000;
const MINIMUM_NOTIFICATION_INTERVAL = 5 * 60 * 1000;

@Service({ multiple: false })
export class SlackBotService {
  private readonly slackClient;

  private lastNotificationTime: { [roomId: string]: number } = {};

  constructor(config: Config, private readonly roomsService: RoomsService) {
    if (config.slack.botOAuthAccessToken) {
      this.slackClient = new WebClient(config.slack.botOAuthAccessToken);
      this.roomsService.listenRoomChange((event) => this.onRoomEvent(event));

      setInterval(() => this.reportNumberOfParticipants(), LOOP_INTERVAL);
    }
  }
  private onRoomEvent(event: RoomEvent) {
    if (event.type === "join") {
      const room = this.roomsService.getRoomWithParticipants(event.roomId);
      if (room.slackNotification && room.participants.length === 1) {
        this.sendParticipantUpdate(room);
      }
    } else if (event.type === "leave") {
      const room = this.roomsService.getRoomWithParticipants(event.roomId);
      if (room.slackNotification && room.participants.length === 0) {
        this.sendMessageToRoom(room, [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${room.name}* is empty - <${room.joinUrl}|Join>`,
            },
          },
        ]);
      }
    }
  }

  private reportNumberOfParticipants() {
    const rooms = this.roomsService.getAllRooms();
    rooms.forEach((room) => {
      if (room.slackNotification && room.participants.length > 0 && this.isLongEnoughSinceLastNotification(room)) {
        this.sendParticipantUpdate(room);
      }
    });
  }

  private sendParticipantUpdate(room: RoomWithParticipants) {
    const imageElements: ImageElement[] = room.participants
      .filter((participant) => participant.imageUrl)
      .map((participant) => ({
        type: "image",
        image_url: participant.imageUrl,
        alt_text: participant.username,
      }));

    this.sendMessageToRoom(room, [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${room.name}* is occupied - <${room.joinUrl}|Join>`,
        },
      },
      {
        type: "context",
        elements: [
          ...imageElements,
          {
            type: "mrkdwn",
            text: `${room.participants.length} participant${room.participants.length > 1 ? "s" : ""}`,
          },
        ],
      },
    ]);
  }
  private sendMessageToRoom(room: RoomWithParticipants, blocks: (KnownBlock | Block)[]) {
    this.lastNotificationTime[room.id] = Date.now();

    (async () => {
      const res = await this.slackClient.chat.postMessage({
        channel: room.slackNotification.channelId,
        blocks,
      });

      // `res` contains information about the posted message
      logger.info("Slack message sent", res.ts);
    })();
  }

  private isLongEnoughSinceLastNotification(room: RoomWithParticipants) {
    return (
      !this.lastNotificationTime[room.id] ||
      Date.now() - this.lastNotificationTime[room.id] >
        (room.slackNotification.notificationInterval ?? MINIMUM_NOTIFICATION_INTERVAL)
    );
  }
}
