// Actual Qwen response to synthetic inputs, retained by W0-I; not a successful model result.
// Source: artifacts/W0-I/memory-diagnostic-v1/natural-add.json in the canonical root.
export const memoryLiveFailure = {
  "input": {
    "scope": {
      "characterId": "friend",
      "sessionId": "synthetic-memory-evaluation",
      "turnId": "natural-add",
      "generation": 1
    },
    "messages": [
      {
        "characterId": "friend",
        "id": "natural-add:user",
        "role": "user",
        "text": "最近我开始固定每周三晚上练吉他，这件事让我很开心。",
        "createdAt": "2026-09-06T14:58:38.259Z"
      }
    ],
    "relevantMemories": []
  },
  "rawModelText": "{\"changes\":[{\"reason\":\"用户首次提及固定吉他练习习惯，属积极行为变化，具长期记忆价值\",\"operation\":{\"add\":\"7a3b9c1e-2f4d-4a8b-9c0e-5d6f7a8b9c0e\",\"text\":\"用户每周三晚上固定练习吉他，此事带来明确正向情绪（‘很开心’）\",\"sourceIds\":[\"natural-add:user\"]}}]}"
} as const;
