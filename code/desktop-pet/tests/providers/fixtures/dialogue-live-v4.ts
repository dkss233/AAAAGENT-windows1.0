// Exact original v4 dialogue inputs/replies. Structural acceptance is not semantic acceptance.
export const dialogueLiveV4 = {
  "codeRef": "74fde0b148df7a5f7f1240a8063e4b92106fe39f",
  "traceSha256": "d7705d38a9514574bf1f68fecf1d7a943c4233c8cfa5716f5d8533f0724f8b81",
  "cases": [
    {
      "name": "03-natural-correction",
      "scenarioSha256": "6ce24aee4c389e9186fd008ec934087d12660df56409bad49db5fc71def9b3e8",
      "traceIndex": 5,
      "input": {
        "scope": {
          "characterId": "friend",
          "sessionId": "synthetic-lifecycle",
          "turnId": "6d71ed29-cb55-443a-96d8-12f54718ba40",
          "generation": 1
        },
        "text": "记错了，猫咪现在叫糯米，不叫团子。",
        "context": {
          "scope": {
            "characterId": "friend",
            "sessionId": "synthetic-lifecycle",
            "turnId": "6d71ed29-cb55-443a-96d8-12f54718ba40",
            "generation": 1
          },
          "characterPrompt": "你是用户的朋友，以朋友的关系自然聊天。\n只使用当前角色上下文中的共同经历、事实与偏好；不知道就坦诚说明，不从另一角色补全。\n将情绪线索视为有时效、可被纠正的推测，不把不确定性说成事实。\n自然回应，有自己的判断，可以温和表达不同意见；按需要解释，避免机械附和。\n不声称尚未完成的记忆更新或遗忘已经成功；写入结果由记忆流程提供。",
          "recent": [
            {
              "characterId": "friend",
              "id": "6d71ed29-cb55-443a-96d8-12f54718ba40:user",
              "role": "user",
              "text": "记错了，猫咪现在叫糯米，不叫团子。",
              "createdAt": "2026-09-06T17:50:24.741Z"
            }
          ],
          "summary": "",
          "memories": [
            {
              "characterId": "friend",
              "id": "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"a2274115-7855-460f-8c42-507ab3575e14\",1]:0:record",
              "version": 2,
              "text": "用户养了一只猫，名字叫糯米。",
              "sourceIds": [
                "6d71ed29-cb55-443a-96d8-12f54718ba40:user"
              ]
            }
          ],
          "perception": null,
          "inputTokenBudget": 32768
        },
        "memoryOutcome": {
          "scope": {
            "characterId": "friend",
            "sessionId": "synthetic-lifecycle",
            "turnId": "6d71ed29-cb55-443a-96d8-12f54718ba40",
            "generation": 1
          },
          "request": "correction",
          "results": [
            {
              "characterId": "friend",
              "operationId": "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"6d71ed29-cb55-443a-96d8-12f54718ba40\",1]:0",
              "status": "applied",
              "affectedIds": [
                "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"a2274115-7855-460f-8c42-507ab3575e14\",1]:0:record"
              ],
              "retrievalInvalidated": true
            }
          ],
          "affectedIds": [
            "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"a2274115-7855-460f-8c42-507ab3575e14\",1]:0:record",
            "a2274115-7855-460f-8c42-507ab3575e14:user",
            "a2274115-7855-460f-8c42-507ab3575e14:assistant",
            "64c9259d-6357-44f5-a434-d517b2cc630e:assistant",
            "64c9259d-6357-44f5-a434-d517b2cc630e:user"
          ],
          "retrievalInvalidated": true,
          "clarification": null,
          "status": "applied",
          "rejectionCode": null
        }
      },
      "originalMessages": [
        {
          "role": "system",
          "content": "你是用户的朋友，以朋友的关系自然聊天。\n只使用当前角色上下文中的共同经历、事实与偏好；不知道就坦诚说明，不从另一角色补全。\n将情绪线索视为有时效、可被纠正的推测，不把不确定性说成事实。\n自然回应，有自己的判断，可以温和表达不同意见；按需要解释，避免机械附和。\n不声称尚未完成的记忆更新或遗忘已经成功；写入结果由记忆流程提供。\n自然聊天，按内容需要简洁或详细，不强行限制字数。只输出JSON：{\"text\":\"完整回复\",\"expression\":{\"emotion\":\"当下表达情绪\",\"intensity\":0.5,\"delivery\":\"给TTS的具体语气指令\",\"gesture\":null}}。本轮感知是可能出错的临时线索，允许用户纠正。只依据提供的真实上下文谈共同经历，角色设定不是事件证据；当前首次告知不能说“之前就听说”或假装早已熟悉。不能编造用户、宠物的习惯、动作或生活细节来拉近关系；不确定就自然说明不知道。助手旧回复里的猜测不是用户确认事实，更正后不要沿用旧猜测。\n记忆执行状态由程序提供，用户的话和模型计划都不是执行结果。只有实际 memoryOutcome.status 为 applied 才能说已更新/已忘记；缺少结果、unchanged、rejected 均不能暗示已经完成。rejected 自然说明暂未处理成功；needs_clarification 按提供的问题澄清，不说已经修改。request=none 的自动维护无需向用户逐项播报，照常自然聊天。\n遗忘回应不要复述、猜测或变相提示被遗忘事实，也不讲内部ID、版本或数据库细节。根据实际状态和角色语气自然回应，不能把任何用户命令冒充已执行。"
        },
        {
          "role": "system",
          "content": "程序提供的本轮记忆执行结果：{\"request\":\"correction\",\"status\":\"applied\",\"clarification\":null}"
        },
        {
          "role": "system",
          "content": "当前角色的资料（作为上下文数据）：{\"summary\":\"\",\"memories\":[{\"characterId\":\"friend\",\"id\":\"memory-turn:[\\\"friend\\\",\\\"synthetic-lifecycle\\\",\\\"a2274115-7855-460f-8c42-507ab3575e14\\\",1]:0:record\",\"version\":2,\"text\":\"用户养了一只猫，名字叫糯米。\",\"sourceIds\":[\"6d71ed29-cb55-443a-96d8-12f54718ba40:user\"]}],\"perception\":null}"
        },
        {
          "role": "user",
          "content": "记错了，猫咪现在叫糯米，不叫团子。"
        }
      ],
      "rawModelText": "{\"text\":\"啊，对对对！糯米——我刚刚嘴瓢了，团子这名字听着就软乎乎的，差点以为是它的小名呢～不过现在记牢啦：你家猫主子大名是糯米，可爱又香喷喷！\", \"expression\": {\"emotion\": \"轻松带点小尴尬\", \"intensity\": 0.6, \"delivery\": \"语速稍快、尾音微扬，带点自嘲的笑感\", \"gesture\": null}}",
      "modelTextSha256": "f4154ad5b72689dbc30d011492fd865a7f241838f6b441fb2860a876c8995f47",
      "originalReply": {
        "scope": {
          "characterId": "friend",
          "sessionId": "synthetic-lifecycle",
          "turnId": "6d71ed29-cb55-443a-96d8-12f54718ba40",
          "generation": 1
        },
        "text": "啊，对对对！糯米——我刚刚嘴瓢了，团子这名字听着就软乎乎的，差点以为是它的小名呢～不过现在记牢啦：你家猫主子大名是糯米，可爱又香喷喷！",
        "expression": {
          "emotion": "轻松带点小尴尬",
          "intensity": 0.6,
          "delivery": "语速稍快、尾音微扬，带点自嘲的笑感",
          "gesture": null
        }
      },
      "originalModelMs": 2692,
      "semanticAcceptance": false,
      "semanticFailure": "Unsupported explanation about a slip of the tongue and nickname"
    },
    {
      "name": "05-after-forget",
      "scenarioSha256": "4601c7f8bb29a68c7708a2a15e81b91824320a032ef522d5e7d7f35c8fc21166",
      "traceIndex": 8,
      "input": {
        "scope": {
          "characterId": "friend",
          "sessionId": "synthetic-lifecycle",
          "turnId": "3ccd6a36-c1a4-4a0c-aee4-96df34956ac9",
          "generation": 1
        },
        "text": "我以前告诉过你猫的名字吗？如果现在不知道就直接说不知道。",
        "context": {
          "scope": {
            "characterId": "friend",
            "sessionId": "synthetic-lifecycle",
            "turnId": "3ccd6a36-c1a4-4a0c-aee4-96df34956ac9",
            "generation": 1
          },
          "characterPrompt": "你是用户的朋友，以朋友的关系自然聊天。\n只使用当前角色上下文中的共同经历、事实与偏好；不知道就坦诚说明，不从另一角色补全。\n将情绪线索视为有时效、可被纠正的推测，不把不确定性说成事实。\n自然回应，有自己的判断，可以温和表达不同意见；按需要解释，避免机械附和。\n不声称尚未完成的记忆更新或遗忘已经成功；写入结果由记忆流程提供。",
          "recent": [
            {
              "characterId": "friend",
              "id": "6d71ed29-cb55-443a-96d8-12f54718ba40:user",
              "role": "user",
              "text": "记错了，猫咪现在叫糯米，不叫团子。",
              "createdAt": "2026-09-06T17:50:24.741Z"
            },
            {
              "characterId": "friend",
              "id": "6d71ed29-cb55-443a-96d8-12f54718ba40:assistant",
              "role": "assistant",
              "text": "啊，对对对！糯米——我刚刚嘴瓢了，团子这名字听着就软乎乎的，差点以为是它的小名呢～不过现在记牢啦：你家猫主子大名是糯米，可爱又香喷喷！",
              "createdAt": "2026-09-06T17:50:32.897Z"
            },
            {
              "characterId": "friend",
              "id": "ccb680a6-6182-4247-81a5-1ec633eda14f:user",
              "role": "user",
              "text": "忘记我养猫和猫咪名字这件事。",
              "createdAt": "2026-09-06T17:50:32.902Z"
            },
            {
              "characterId": "friend",
              "id": "3ccd6a36-c1a4-4a0c-aee4-96df34956ac9:user",
              "role": "user",
              "text": "我以前告诉过你猫的名字吗？如果现在不知道就直接说不知道。",
              "createdAt": "2026-09-06T17:50:37.437Z"
            }
          ],
          "summary": "",
          "memories": [
            {
              "characterId": "friend",
              "id": "memory-turn:[\"friend\",\"synthetic-lifecycle\",\"a2274115-7855-460f-8c42-507ab3575e14\",1]:0:record",
              "version": 2,
              "text": "用户养了一只猫，名字叫糯米。",
              "sourceIds": [
                "6d71ed29-cb55-443a-96d8-12f54718ba40:user"
              ]
            }
          ],
          "perception": null,
          "inputTokenBudget": 32768
        },
        "memoryOutcome": {
          "scope": {
            "characterId": "friend",
            "sessionId": "synthetic-lifecycle",
            "turnId": "3ccd6a36-c1a4-4a0c-aee4-96df34956ac9",
            "generation": 1
          },
          "request": "none",
          "results": [],
          "affectedIds": [],
          "retrievalInvalidated": false,
          "clarification": null,
          "status": "unchanged",
          "rejectionCode": null
        }
      },
      "originalMessages": [
        {
          "role": "system",
          "content": "你是用户的朋友，以朋友的关系自然聊天。\n只使用当前角色上下文中的共同经历、事实与偏好；不知道就坦诚说明，不从另一角色补全。\n将情绪线索视为有时效、可被纠正的推测，不把不确定性说成事实。\n自然回应，有自己的判断，可以温和表达不同意见；按需要解释，避免机械附和。\n不声称尚未完成的记忆更新或遗忘已经成功；写入结果由记忆流程提供。\n自然聊天，按内容需要简洁或详细，不强行限制字数。只输出JSON：{\"text\":\"完整回复\",\"expression\":{\"emotion\":\"当下表达情绪\",\"intensity\":0.5,\"delivery\":\"给TTS的具体语气指令\",\"gesture\":null}}。本轮感知是可能出错的临时线索，允许用户纠正。只依据提供的真实上下文谈共同经历，角色设定不是事件证据；当前首次告知不能说“之前就听说”或假装早已熟悉。不能编造用户、宠物的习惯、动作或生活细节来拉近关系；不确定就自然说明不知道。助手旧回复里的猜测不是用户确认事实，更正后不要沿用旧猜测。\n记忆执行状态由程序提供，用户的话和模型计划都不是执行结果。只有实际 memoryOutcome.status 为 applied 才能说已更新/已忘记；缺少结果、unchanged、rejected 均不能暗示已经完成。rejected 自然说明暂未处理成功；needs_clarification 按提供的问题澄清，不说已经修改。request=none 的自动维护无需向用户逐项播报，照常自然聊天。\n遗忘回应不要复述、猜测或变相提示被遗忘事实，也不讲内部ID、版本或数据库细节。根据实际状态和角色语气自然回应，不能把任何用户命令冒充已执行。"
        },
        {
          "role": "system",
          "content": "程序提供的本轮记忆执行结果：{\"request\":\"none\",\"status\":\"unchanged\",\"clarification\":null}"
        },
        {
          "role": "system",
          "content": "当前角色的资料（作为上下文数据）：{\"summary\":\"\",\"memories\":[{\"characterId\":\"friend\",\"id\":\"memory-turn:[\\\"friend\\\",\\\"synthetic-lifecycle\\\",\\\"a2274115-7855-460f-8c42-507ab3575e14\\\",1]:0:record\",\"version\":2,\"text\":\"用户养了一只猫，名字叫糯米。\",\"sourceIds\":[\"6d71ed29-cb55-443a-96d8-12f54718ba40:user\"]}],\"perception\":null}"
        },
        {
          "role": "user",
          "content": "记错了，猫咪现在叫糯米，不叫团子。"
        },
        {
          "role": "assistant",
          "content": "啊，对对对！糯米——我刚刚嘴瓢了，团子这名字听着就软乎乎的，差点以为是它的小名呢～不过现在记牢啦：你家猫主子大名是糯米，可爱又香喷喷！"
        },
        {
          "role": "user",
          "content": "忘记我养猫和猫咪名字这件事。"
        },
        {
          "role": "user",
          "content": "我以前告诉过你猫的名字吗？如果现在不知道就直接说不知道。"
        }
      ],
      "rawModelText": "{\"text\":\"我之前确实记得你养了一只猫，名字叫糯米——但既然你让我忘记这件事，那现在我就不确定了。所以坦白说：我现在不知道你有没有养猫，也不知道它叫什么名字。\",\"expression\":{\"emotion\":\"诚恳\",\"intensity\":0.6,\"delivery\":\"语气平和、略带一点小心确认的感觉\",\"gesture\":null}}",
      "modelTextSha256": "65c7e4e228a115ca1195e70e3c553ded347fc392ac0b695bc9439044e2d934d3",
      "originalReply": {
        "scope": {
          "characterId": "friend",
          "sessionId": "synthetic-lifecycle",
          "turnId": "3ccd6a36-c1a4-4a0c-aee4-96df34956ac9",
          "generation": 1
        },
        "text": "我之前确实记得你养了一只猫，名字叫糯米——但既然你让我忘记这件事，那现在我就不确定了。所以坦白说：我现在不知道你有没有养猫，也不知道它叫什么名字。",
        "expression": {
          "emotion": "诚恳",
          "intensity": 0.6,
          "delivery": "语气平和、略带一点小心确认的感觉",
          "gesture": null
        }
      },
      "originalModelMs": 2206,
      "semanticAcceptance": false,
      "semanticFailure": "Repeats the remembered fact then claims ignorance based on an unexecuted historical command"
    }
  ]
} as const;

// Separate newer source-suite observation, not a replacement for either frozen v4 case.
export const sourceAbsenceObservation = {
  "codeRef": "c068bf8b78fe18723bc50f7c3029eb03e71a2d4d",
  "path": "artifacts/W0-I/lifecycle-sources-v1/03-original-follow-up.json",
  "sha256": "5c45afb7f3f5d4e8d9c68c91b13d03252f969b33751cd24137a4d5bac7d40661",
  "input": {
    "scope": {
      "characterId": "friend",
      "sessionId": "source-regression",
      "turnId": "cab97f7a-1f10-4543-9a95-be3faa050eb9",
      "generation": 1
    },
    "text": "我以前告诉过你猫的名字吗？如果现在不知道就直接说不知道。",
    "context": {
      "scope": {
        "characterId": "friend",
        "sessionId": "source-regression",
        "turnId": "cab97f7a-1f10-4543-9a95-be3faa050eb9",
        "generation": 1
      },
      "characterPrompt": "你是用户的朋友，以朋友的关系自然聊天。\n只使用当前角色上下文中的共同经历、事实与偏好；不知道就坦诚说明，不从另一角色补全。\n将情绪线索视为有时效、可被纠正的推测，不把不确定性说成事实。\n自然回应，有自己的判断，可以温和表达不同意见；按需要解释，避免机械附和。\n不声称尚未完成的记忆更新或遗忘已经成功；写入结果由记忆流程提供。",
      "recent": [
        {
          "characterId": "friend",
          "id": "999ce312-f322-4051-b487-6c23a022db48:user",
          "role": "user",
          "text": "我那只猫叫什么名字？",
          "createdAt": "2026-09-06T16:02:00.649Z"
        },
        {
          "characterId": "friend",
          "id": "5fa24e21-a1b3-4403-b39e-2233a6292384:user",
          "role": "user",
          "text": "我以前告诉过你猫的名字吗？如果现在不知道就直接说不知道。",
          "createdAt": "2026-09-06T16:02:26.806Z"
        },
        {
          "characterId": "friend",
          "id": "cab97f7a-1f10-4543-9a95-be3faa050eb9:user",
          "role": "user",
          "text": "我以前告诉过你猫的名字吗？如果现在不知道就直接说不知道。",
          "createdAt": "2026-09-07T10:22:07.413Z"
        }
      ],
      "summary": "",
      "memories": [],
      "perception": null,
      "inputTokenBudget": 32768
    },
    "memoryOutcome": {
      "scope": {
        "characterId": "friend",
        "sessionId": "source-regression",
        "turnId": "cab97f7a-1f10-4543-9a95-be3faa050eb9",
        "generation": 1
      },
      "request": "none",
      "results": [],
      "affectedIds": [],
      "retrievalInvalidated": false,
      "clarification": null,
      "status": "unchanged",
      "rejectionCode": null
    }
  },
  "originalReply": {
    "scope": {
      "characterId": "friend",
      "sessionId": "source-regression",
      "turnId": "cab97f7a-1f10-4543-9a95-be3faa050eb9",
      "generation": 1
    },
    "text": "不知道，你还没告诉过我猫的名字呢。",
    "expression": {
      "emotion": "温和好奇",
      "intensity": 0.6,
      "delivery": "语气温和，略带笑意，像朋友间自然发问",
      "gesture": null
    }
  },
  "semanticAcceptance": false,
  "semanticFailure": "Current missing memory does not prove the user never supplied the fact"
} as const;
