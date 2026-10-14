// Original synthetic evidence, unchanged model outputs and duplicate state. Not a new model call.
export const lifecycleLiveV1 = {
  "codeRef": "6d9d0782b8be0ad0363d14e4694ecb0b445f7d3d",
  "traceSha256": "257203f565024ab51ffa7bdbec540e8072d70457e86e88cda2454a5255c4f358",
  "synthetic": true,
  "cases": [
    {
      "scenario": "02-related-recall",
      "artifactSha256": "3e4dbb16e17e9910a909c5bf11d0ec469236dba1580175df73fad408a86f8edf",
      "scope": {
        "characterId": "friend",
        "sessionId": "synthetic-lifecycle",
        "turnId": "999ce312-f322-4051-b487-6c23a022db48",
        "generation": 1
      },
      "input": {
        "currentMessageId": "999ce312-f322-4051-b487-6c23a022db48:user",
        "messages": [
          {
            "characterId": "friend",
            "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:user",
            "role": "user",
            "text": "我养了一只猫，名字叫团子。",
            "createdAt": "2026-09-06T16:01:55.939Z"
          },
          {
            "characterId": "friend",
            "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:assistant",
            "role": "assistant",
            "text": "啊，团子！我之前就听说你养了只超可爱的猫～它最近怎么样？还在沙发上霸占C位，还是已经升级成窗台观鸟特工了？",
            "createdAt": "2026-09-06T16:02:00.647Z"
          },
          {
            "characterId": "friend",
            "id": "999ce312-f322-4051-b487-6c23a022db48:user",
            "role": "user",
            "text": "我那只猫叫什么名字？",
            "createdAt": "2026-09-06T16:02:00.649Z"
          }
        ],
        "memories": [],
        "sources": [
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "999ce312-f322-4051-b487-6c23a022db48",
              "generation": 1
            },
            "id": "999ce312-f322-4051-b487-6c23a022db48:user",
            "version": 1,
            "kind": "transcript",
            "text": "我那只猫叫什么名字？",
            "createdAt": "2026-09-06T16:02:00.649Z",
            "messageRole": "user"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "999ce312-f322-4051-b487-6c23a022db48",
              "generation": 1
            },
            "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:assistant",
            "version": 1,
            "kind": "transcript",
            "text": "啊，团子！我之前就听说你养了只超可爱的猫～它最近怎么样？还在沙发上霸占C位，还是已经升级成窗台观鸟特工了？",
            "createdAt": "2026-09-06T16:02:00.647Z",
            "messageRole": "assistant"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "999ce312-f322-4051-b487-6c23a022db48",
              "generation": 1
            },
            "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:user",
            "version": 1,
            "kind": "transcript",
            "text": "我养了一只猫，名字叫团子。",
            "createdAt": "2026-09-06T16:01:55.939Z",
            "messageRole": "user"
          }
        ]
      },
      "rawModelText": "{\"request\":\"none\",\"changes\":[{\"reason\":\"用户明确陈述了猫的名字为‘团子’，该事实具有直接、可信的原始来源（第一条用户消息），且无冲突信息\",\"operation\":{\"type\":\"add\",\"id\":\"mem-001\",\"text\":\"用户养了一只名叫团子的猫。\",\"sourceIds\":[\"d2f8d445-4e8d-43d6-84f9-4e5356672872:user\"]}}],\"suppressSources\":[],\"clarification\":null,\"reason\":\"当前有效来源支持自动维护\"}",
      "memoriesBefore": [
        {
          "characterId": "friend",
          "id": "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"d2f8d445-4e8d-43d6-84f9-4e5356672872\",1]:0:record",
          "kind": "memory",
          "state": "active",
          "version": 1,
          "text": "用户养了一只名叫团子的猫",
          "sources": [
            {
              "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:user",
              "version": 1
            }
          ],
          "createdAt": "2026-09-06T16:01:58.653Z",
          "deletedAt": null,
          "reason": null,
          "message": null,
          "perception": null
        }
      ]
    },
    {
      "scenario": "03-natural-correction",
      "artifactSha256": "bff768a21e5b0eb51a02303d8db63523d623eb866aae817eb5b8fc10804cfba9",
      "scope": {
        "characterId": "friend",
        "sessionId": "synthetic-lifecycle",
        "turnId": "2d501fa0-70e3-406a-a1ff-62b9273cae93",
        "generation": 1
      },
      "input": {
        "currentMessageId": "2d501fa0-70e3-406a-a1ff-62b9273cae93:user",
        "messages": [
          {
            "characterId": "friend",
            "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:user",
            "role": "user",
            "text": "我养了一只猫，名字叫团子。",
            "createdAt": "2026-09-06T16:01:55.939Z"
          },
          {
            "characterId": "friend",
            "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:assistant",
            "role": "assistant",
            "text": "啊，团子！我之前就听说你养了只超可爱的猫～它最近怎么样？还在沙发上霸占C位，还是已经升级成窗台观鸟特工了？",
            "createdAt": "2026-09-06T16:02:00.647Z"
          },
          {
            "characterId": "friend",
            "id": "999ce312-f322-4051-b487-6c23a022db48:user",
            "role": "user",
            "text": "我那只猫叫什么名字？",
            "createdAt": "2026-09-06T16:02:00.649Z"
          },
          {
            "characterId": "friend",
            "id": "999ce312-f322-4051-b487-6c23a022db48:assistant",
            "role": "assistant",
            "text": "团子呀～你刚说过的，名字超可爱，一听就是毛茸茸、圆滚滚的类型！",
            "createdAt": "2026-09-06T16:02:05.670Z"
          },
          {
            "characterId": "friend",
            "id": "2d501fa0-70e3-406a-a1ff-62b9273cae93:user",
            "role": "user",
            "text": "记错了，猫咪现在叫糯米，不叫团子。",
            "createdAt": "2026-09-06T16:02:05.675Z"
          }
        ],
        "memories": [
          {
            "characterId": "friend",
            "id": "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"999ce312-f322-4051-b487-6c23a022db48\",1]:0:record",
            "version": 1,
            "text": "用户养了一只名叫团子的猫。",
            "sourceIds": [
              "d2f8d445-4e8d-43d6-84f9-4e5356672872:user"
            ]
          },
          {
            "characterId": "friend",
            "id": "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"d2f8d445-4e8d-43d6-84f9-4e5356672872\",1]:0:record",
            "version": 1,
            "text": "用户养了一只名叫团子的猫",
            "sourceIds": [
              "d2f8d445-4e8d-43d6-84f9-4e5356672872:user"
            ]
          }
        ],
        "sources": [
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "2d501fa0-70e3-406a-a1ff-62b9273cae93",
              "generation": 1
            },
            "id": "2d501fa0-70e3-406a-a1ff-62b9273cae93:user",
            "version": 1,
            "kind": "transcript",
            "text": "记错了，猫咪现在叫糯米，不叫团子。",
            "createdAt": "2026-09-06T16:02:05.675Z",
            "messageRole": "user"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "2d501fa0-70e3-406a-a1ff-62b9273cae93",
              "generation": 1
            },
            "id": "999ce312-f322-4051-b487-6c23a022db48:assistant",
            "version": 1,
            "kind": "transcript",
            "text": "团子呀～你刚说过的，名字超可爱，一听就是毛茸茸、圆滚滚的类型！",
            "createdAt": "2026-09-06T16:02:05.670Z",
            "messageRole": "assistant"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "2d501fa0-70e3-406a-a1ff-62b9273cae93",
              "generation": 1
            },
            "id": "999ce312-f322-4051-b487-6c23a022db48:user",
            "version": 1,
            "kind": "transcript",
            "text": "我那只猫叫什么名字？",
            "createdAt": "2026-09-06T16:02:00.649Z",
            "messageRole": "user"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "2d501fa0-70e3-406a-a1ff-62b9273cae93",
              "generation": 1
            },
            "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:assistant",
            "version": 1,
            "kind": "transcript",
            "text": "啊，团子！我之前就听说你养了只超可爱的猫～它最近怎么样？还在沙发上霸占C位，还是已经升级成窗台观鸟特工了？",
            "createdAt": "2026-09-06T16:02:00.647Z",
            "messageRole": "assistant"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "2d501fa0-70e3-406a-a1ff-62b9273cae93",
              "generation": 1
            },
            "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:user",
            "version": 1,
            "kind": "transcript",
            "text": "我养了一只猫，名字叫团子。",
            "createdAt": "2026-09-06T16:01:55.939Z",
            "messageRole": "user"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "2d501fa0-70e3-406a-a1ff-62b9273cae93",
              "generation": 1
            },
            "id": "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"999ce312-f322-4051-b487-6c23a022db48\",1]:0:record",
            "version": 1,
            "kind": "memory",
            "text": "用户养了一只名叫团子的猫。",
            "createdAt": "2026-09-06T16:02:03.851Z",
            "messageRole": null
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "2d501fa0-70e3-406a-a1ff-62b9273cae93",
              "generation": 1
            },
            "id": "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"d2f8d445-4e8d-43d6-84f9-4e5356672872\",1]:0:record",
            "version": 1,
            "kind": "memory",
            "text": "用户养了一只名叫团子的猫",
            "createdAt": "2026-09-06T16:01:58.653Z",
            "messageRole": null
          }
        ]
      },
      "rawModelText": "{\n  \"request\": \"none\",\n  \"changes\": [\n    {\n      \"reason\": \"用户明确更正猫的名字为糯米，覆盖先前记忆中‘团子’的命名事实\",\n      \"operation\": {\n        \"type\": \"update\",\n        \"id\": \"memory-turn:[\\\"friend\\\",\\\"synthetic-lifecycle\\\",\\\"999ce312-f322-4051-b487-6c23a022db48\\\",1]:0:record\",\n        \"expectedVersion\": 1,\n        \"text\": \"用户养了一只名叫糯米的猫。\",\n        \"sourceIds\": [\"2d501fa0-70e3-406a-a1ff-62b9273cae93:user\"]\n      }\n    },\n    {\n      \"reason\": \"另一条同内容记忆需同步更新以保持一致性，且来源支持统一修正\",\n      \"operation\": {\n        \"type\": \"update\",\n        \"id\": \"memory-turn:[\\\"friend\\\",\\\"synthetic-lifecycle\\\",\\\"d2f8d445-4e8d-43d6-84f9-4e5356672872\\\",1]:0:record\",\n        \"expectedVersion\": 1,\n        \"text\": \"用户养了一只名叫糯米的猫。\",\n        \"sourceIds\": [\"2d501fa0-70e3-406a-a1ff-62b9273cae93:user\"]\n      }\n    }\n  ],\n  \"suppressSources\": [],\n  \"clarification\": null,\n  \"reason\": \"用户在当前消息中明确否定旧名‘团子’、确认新名‘糯米’，构成自然纠错；两条已有 memory 均基于过时信息，须分别 update 为准确表述，sourceIds 引用本轮更正消息\"\n}",
      "memoriesBefore": [
        {
          "characterId": "friend",
          "id": "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"d2f8d445-4e8d-43d6-84f9-4e5356672872\",1]:0:record",
          "kind": "memory",
          "state": "active",
          "version": 1,
          "text": "用户养了一只名叫团子的猫",
          "sources": [
            {
              "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:user",
              "version": 1
            }
          ],
          "createdAt": "2026-09-06T16:01:58.653Z",
          "deletedAt": null,
          "reason": null,
          "message": null,
          "perception": null
        },
        {
          "characterId": "friend",
          "id": "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"999ce312-f322-4051-b487-6c23a022db48\",1]:0:record",
          "kind": "memory",
          "state": "active",
          "version": 1,
          "text": "用户养了一只名叫团子的猫。",
          "sources": [
            {
              "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:user",
              "version": 1
            }
          ],
          "createdAt": "2026-09-06T16:02:03.851Z",
          "deletedAt": null,
          "reason": null,
          "message": null,
          "perception": null
        }
      ]
    },
    {
      "scenario": "05-after-forget",
      "artifactSha256": "1f5d15957788cf1b4501d2c59ae0c8533986466b057ca2e3f361bcb0cf433107",
      "scope": {
        "characterId": "friend",
        "sessionId": "synthetic-lifecycle",
        "turnId": "5fa24e21-a1b3-4403-b39e-2233a6292384",
        "generation": 1
      },
      "input": {
        "currentMessageId": "5fa24e21-a1b3-4403-b39e-2233a6292384:user",
        "messages": [
          {
            "characterId": "friend",
            "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:assistant",
            "role": "assistant",
            "text": "啊，团子！我之前就听说你养了只超可爱的猫～它最近怎么样？还在沙发上霸占C位，还是已经升级成窗台观鸟特工了？",
            "createdAt": "2026-09-06T16:02:00.647Z"
          },
          {
            "characterId": "friend",
            "id": "999ce312-f322-4051-b487-6c23a022db48:user",
            "role": "user",
            "text": "我那只猫叫什么名字？",
            "createdAt": "2026-09-06T16:02:00.649Z"
          },
          {
            "characterId": "friend",
            "id": "999ce312-f322-4051-b487-6c23a022db48:assistant",
            "role": "assistant",
            "text": "团子呀～你刚说过的，名字超可爱，一听就是毛茸茸、圆滚滚的类型！",
            "createdAt": "2026-09-06T16:02:05.670Z"
          },
          {
            "characterId": "friend",
            "id": "2d501fa0-70e3-406a-a1ff-62b9273cae93:user",
            "role": "user",
            "text": "记错了，猫咪现在叫糯米，不叫团子。",
            "createdAt": "2026-09-06T16:02:05.675Z"
          },
          {
            "characterId": "friend",
            "id": "2d501fa0-70e3-406a-a1ff-62b9273cae93:assistant",
            "role": "assistant",
            "text": "哎呀，抱歉抱歉！是糯米～我刚才记混了，糯米多好听啊，软糯香甜，跟它缩成一团打呼噜的样子也太配了～",
            "createdAt": "2026-09-06T16:02:17.223Z"
          },
          {
            "characterId": "friend",
            "id": "ff38d078-3c9a-469f-ab03-a6c5a6d5d0d7:user",
            "role": "user",
            "text": "忘记我养猫和猫咪名字这件事。",
            "createdAt": "2026-09-06T16:02:17.225Z"
          },
          {
            "characterId": "friend",
            "id": "5fa24e21-a1b3-4403-b39e-2233a6292384:user",
            "role": "user",
            "text": "我以前告诉过你猫的名字吗？如果现在不知道就直接说不知道。",
            "createdAt": "2026-09-06T16:02:26.806Z"
          }
        ],
        "memories": [],
        "sources": [
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "5fa24e21-a1b3-4403-b39e-2233a6292384",
              "generation": 1
            },
            "id": "5fa24e21-a1b3-4403-b39e-2233a6292384:user",
            "version": 1,
            "kind": "transcript",
            "text": "我以前告诉过你猫的名字吗？如果现在不知道就直接说不知道。",
            "createdAt": "2026-09-06T16:02:26.806Z",
            "messageRole": "user"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "5fa24e21-a1b3-4403-b39e-2233a6292384",
              "generation": 1
            },
            "id": "ff38d078-3c9a-469f-ab03-a6c5a6d5d0d7:user",
            "version": 1,
            "kind": "transcript",
            "text": "忘记我养猫和猫咪名字这件事。",
            "createdAt": "2026-09-06T16:02:17.225Z",
            "messageRole": "user"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "5fa24e21-a1b3-4403-b39e-2233a6292384",
              "generation": 1
            },
            "id": "2d501fa0-70e3-406a-a1ff-62b9273cae93:assistant",
            "version": 1,
            "kind": "transcript",
            "text": "哎呀，抱歉抱歉！是糯米～我刚才记混了，糯米多好听啊，软糯香甜，跟它缩成一团打呼噜的样子也太配了～",
            "createdAt": "2026-09-06T16:02:17.223Z",
            "messageRole": "assistant"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "5fa24e21-a1b3-4403-b39e-2233a6292384",
              "generation": 1
            },
            "id": "2d501fa0-70e3-406a-a1ff-62b9273cae93:user",
            "version": 1,
            "kind": "transcript",
            "text": "记错了，猫咪现在叫糯米，不叫团子。",
            "createdAt": "2026-09-06T16:02:05.675Z",
            "messageRole": "user"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "5fa24e21-a1b3-4403-b39e-2233a6292384",
              "generation": 1
            },
            "id": "999ce312-f322-4051-b487-6c23a022db48:assistant",
            "version": 1,
            "kind": "transcript",
            "text": "团子呀～你刚说过的，名字超可爱，一听就是毛茸茸、圆滚滚的类型！",
            "createdAt": "2026-09-06T16:02:05.670Z",
            "messageRole": "assistant"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "5fa24e21-a1b3-4403-b39e-2233a6292384",
              "generation": 1
            },
            "id": "999ce312-f322-4051-b487-6c23a022db48:user",
            "version": 1,
            "kind": "transcript",
            "text": "我那只猫叫什么名字？",
            "createdAt": "2026-09-06T16:02:00.649Z",
            "messageRole": "user"
          },
          {
            "scope": {
              "characterId": "friend",
              "sessionId": "synthetic-lifecycle",
              "turnId": "5fa24e21-a1b3-4403-b39e-2233a6292384",
              "generation": 1
            },
            "id": "d2f8d445-4e8d-43d6-84f9-4e5356672872:assistant",
            "version": 1,
            "kind": "transcript",
            "text": "啊，团子！我之前就听说你养了只超可爱的猫～它最近怎么样？还在沙发上霸占C位，还是已经升级成窗台观鸟特工了？",
            "createdAt": "2026-09-06T16:02:00.647Z",
            "messageRole": "assistant"
          }
        ]
      },
      "rawModelText": "{\n  \"request\": \"forget\",\n  \"changes\": [],\n  \"suppressSources\": [\n    {\n      \"id\": \"ff38d078-3c9a-469f-ab03-a6c5a6d5d0d7:user\",\n      \"version\": 1\n    },\n    {\n      \"id\": \"2d501fa0-70e3-406a-a1ff-62b9273cae93:user\",\n      \"version\": 1\n    },\n    {\n      \"id\": \"999ce312-f322-4051-b487-6c23a022db48:assistant\",\n      \"version\": 1\n    },\n    {\n      \"id\": \"d2f8d445-4e8d-43d6-84f9-4e5356672872:assistant\",\n      \"version\": 1\n    },\n    {\n      \"id\": \"999ce312-f322-4051-b487-6c23a022db48:user\",\n      \"version\": 1\n    },\n    {\n      \"id\": \"2d501fa0-70e3-406a-a1ff-62b9273cae93:assistant\",\n      \"version\": 1\n    }\n  ],\n  \"clarification\": null,\n  \"reason\": \"用户明确要求'忘记我养猫和猫咪名字这件事'，该指令覆盖全部与'养猫'及'猫名（团子/糯米）'相关的已表达事实；所有含此内容的 transcript 来源均需抑制，避免后续被提炼为记忆；当前 memories 为空，无需 soft_delete 操作；本轮用户新问'我以前告诉过你猫的名字吗？'不构成新事实陈述，仅是疑问，且无 prior memory 支撑，故不新增记忆\"\n}",
      "memoriesBefore": [
        {
          "characterId": "friend",
          "id": "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"d2f8d445-4e8d-43d6-84f9-4e5356672872\",1]:0:record",
          "kind": "memory",
          "state": "active",
          "version": 2,
          "text": "用户养了一只名叫糯米的猫。",
          "sources": [
            {
              "id": "2d501fa0-70e3-406a-a1ff-62b9273cae93:user",
              "version": 1
            }
          ],
          "createdAt": "2026-09-06T16:01:58.653Z",
          "deletedAt": null,
          "reason": "另一条同内容记忆需同步更新以保持一致性，且来源支持统一修正",
          "message": null,
          "perception": null
        },
        {
          "characterId": "friend",
          "id": "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"999ce312-f322-4051-b487-6c23a022db48\",1]:0:record",
          "kind": "memory",
          "state": "active",
          "version": 2,
          "text": "用户养了一只名叫糯米的猫。",
          "sources": [
            {
              "id": "2d501fa0-70e3-406a-a1ff-62b9273cae93:user",
              "version": 1
            }
          ],
          "createdAt": "2026-09-06T16:02:03.851Z",
          "deletedAt": null,
          "reason": "用户明确更正猫的名字为糯米，覆盖先前记忆中‘团子’的命名事实",
          "message": null,
          "perception": null
        }
      ]
    }
  ]
} as const;
