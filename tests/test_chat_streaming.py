import json
import sqlite3
import unittest
from unittest.mock import patch
from uuid import uuid4

import main


class FakeOllamaResponse:
    def __init__(self, chunks):
        self.chunks = chunks
        self.exits = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        self.exits += 1
        return False

    def raise_for_status(self):
        return None

    def json(self):
        return {"done": True, "message": {"content": "complete"}}

    async def aiter_lines(self):
        for chunk in self.chunks:
            yield json.dumps(chunk, ensure_ascii=False)


class FakeOllamaClient:
    def __init__(self, chunks):
        self.response = FakeOllamaResponse(chunks)
        self.request = None
        self.exits = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        self.exits += 1
        return False

    def stream(self, method, url, *, json):
        self.request = (method, url, json)
        return self.response

    async def post(self, url, *, json):
        self.request = ("POST", url, json)
        return self.response


class ChatStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def run_stream(self, chunks, *, memory_record=None, save_side_effect=None):
        conversation_id = str(uuid4())
        request = main.ChatRequest(
            conversation_id=conversation_id,
            message="  hello  ",
            memory_key="preferred" if memory_record else None,
        )
        client = FakeOllamaClient(chunks)
        save = patch("main.storage.save_exchange", side_effect=save_side_effect)
        with (
            patch("main.storage.conversation_exists", return_value=True),
            patch("main.storage.get_messages", return_value=[]),
            patch("main.memory.validate_key"),
            patch("main.memory.get_record", return_value=memory_record),
            patch("main.httpx.AsyncClient", return_value=client),
            save as save_exchange,
        ):
            response = await main.chat_stream(request)
            events = []
            async for chunk in response.body_iterator:
                frame = chunk.decode() if isinstance(chunk, bytes) else chunk
                event = frame.splitlines()[0].removeprefix("event: ")
                payload = json.loads(frame.splitlines()[1].removeprefix("data: "))
                events.append((event, payload, save_exchange.call_count))

        self.assertEqual(client.exits, 1)
        self.assertEqual(client.response.exits, 1)
        self.assertFalse(main.chat_lock.locked())
        self.assertEqual(client.request[0:2], ("POST", main.OLLAMA_URL))
        self.assertTrue(client.request[2]["stream"])
        self.assertEqual(client.request[2]["options"], {"num_ctx": 4096, "num_predict": 256})
        return events, save_exchange, conversation_id, client.request[2]

    async def test_complete_reply_saves_before_confirmation_and_includes_memory(self):
        record = {
            "id": 7,
            "memory_key": "preferred",
            "value": "caf\u00e9",
            "origin": "explicit_user_request",
            "confirmation_status": "user_confirmed",
            "created_at": "2026-10-27T00:00:00Z",
        }
        chunks = [
            {"message": {"content": "caf\u00e9 "}, "done": False},
            {"message": {"content": "done"}, "done": True},
        ]
        events, save, conversation_id, payload = await self.run_stream(
            chunks,
            memory_record=record,
        )

        self.assertEqual([event for event, _, _ in events], ["text", "text", "completion"])
        self.assertEqual(events[-1][1]["memory_used"], [record])
        self.assertEqual(events[-1][2], 1)
        self.assertEqual(save.call_args.args, (conversation_id, "hello", "caf\u00e9 done"))
        self.assertIn("caf\u00e9", payload["messages"][-2]["content"])

    async def test_legacy_chat_endpoint_remains_non_streaming(self):
        conversation_id = str(uuid4())
        request = main.ChatRequest(conversation_id=conversation_id, message="hello")
        client = FakeOllamaClient([])
        with (
            patch("main.storage.conversation_exists", return_value=True),
            patch("main.storage.get_messages", return_value=[]),
            patch("main.storage.save_exchange") as save_exchange,
            patch("main.httpx.AsyncClient", return_value=client),
        ):
            result = await main.chat(request)

        self.assertFalse(client.request[2]["stream"])
        self.assertEqual(result["reply"], "complete")
        self.assertEqual(result["memory_used"], [])
        save_exchange.assert_called_once_with(conversation_id, "hello", "complete")
        self.assertFalse(main.chat_lock.locked())

    async def test_missing_ollama_completion_never_saves(self):
        events, save, _, _ = await self.run_stream([
            {"message": {"content": "partial"}, "done": False},
        ])

        self.assertEqual([event for event, _, _ in events], ["text", "error"])
        self.assertEqual(events[-1][1]["detail"], "Ollama returned an invalid or incomplete response.")
        save.assert_not_called()

    async def test_closing_client_stream_releases_http_resources_and_chat_lock(self):
        conversation_id = str(uuid4())
        request = main.ChatRequest(conversation_id=conversation_id, message="hello")
        client = FakeOllamaClient([
            {"message": {"content": "partial"}, "done": False},
            {"message": {"content": "remaining"}, "done": True},
        ])
        with (
            patch("main.storage.conversation_exists", return_value=True),
            patch("main.storage.get_messages", return_value=[]),
            patch("main.storage.save_exchange"),
            patch("main.httpx.AsyncClient", return_value=client),
        ):
            response = await main.chat_stream(request)
            iterator = response.body_iterator
            first = await iterator.__anext__()
            self.assertIn('"text": "partial"', first)
            await iterator.aclose()

        self.assertEqual(client.exits, 1)
        self.assertEqual(client.response.exits, 1)
        self.assertFalse(main.chat_lock.locked())

    async def test_database_failure_sends_error_without_completion(self):
        events, save, _, _ = await self.run_stream(
            [{"message": {"content": "complete"}, "done": True}],
            save_side_effect=sqlite3.OperationalError("isolated test failure"),
        )

        self.assertEqual([event for event, _, _ in events], ["text", "error"])
        self.assertIn("could not be saved", events[-1][1]["detail"])
        save.assert_called_once()


if __name__ == "__main__":
    unittest.main()
