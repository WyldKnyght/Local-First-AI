import asyncio
import json
import sqlite3
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
import main

_END = object()


class FakeOllamaResponse:
    def __init__(self, chunks=()):
        self.queue = asyncio.Queue()
        self.started = asyncio.Event()
        self.exits = 0
        for chunk in chunks:
            self.queue.put_nowait(chunk)
        if chunks:
            self.queue.put_nowait(_END)

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
        self.started.set()
        while True:
            item = await self.queue.get()
            if item is _END:
                return
            if isinstance(item, Exception):
                raise item
            yield json.dumps(item, ensure_ascii=False)

    async def push(self, chunk):
        await self.queue.put(chunk)

    async def finish(self):
        await self.queue.put(_END)


class FakeOllamaClient:
    def __init__(self, response):
        self.response = response
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


class ChatStreamingCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main.chat_lock = asyncio.Lock()
        main.stream_requests = main.StreamRequestRegistry()

    def request(self, request_id=None, *, message="hello", memory_key=None):
        return main.StreamChatRequest(
            conversation_id=uuid4(),
            request_id=request_id or uuid4(),
            message=message,
            memory_key=memory_key,
        )

    async def consume(self, response):
        events = []
        async for chunk in response.body_iterator:
            frame = chunk.decode() if isinstance(chunk, bytes) else chunk
            lines = frame.splitlines()
            events.append((lines[0].removeprefix("event: "), json.loads(lines[1].removeprefix("data: "))))
        return events

    async def test_cancel_before_first_token_is_acknowledged_after_registration_and_cleanup(self):
        request = self.request()
        client = FakeOllamaClient(FakeOllamaResponse())
        with (
            patch("main.storage.conversation_exists", return_value=True),
            patch("main.storage.get_messages", return_value=[]),
            patch("main.httpx.AsyncClient", return_value=client) as client_factory,
            patch("main.storage.save_exchange") as save,
        ):
            stream = await main.chat_stream(request)
            consume_task = asyncio.create_task(self.consume(stream))
            await client.response.started.wait()
            outcome = await main.cancel_chat_stream(request.request_id)
            events = await consume_task
            repeated = await main.cancel_chat_stream(request.request_id)
            status = await main.chat_stream_status(request.request_id)

        self.assertEqual(outcome["status"], "cancelled")
        self.assertFalse(outcome["saved"])
        self.assertEqual(repeated, outcome)
        self.assertEqual(status, outcome)
        self.assertEqual([name for name, _ in events], ["cancelled"])
        self.assertEqual(events[0][1], outcome)
        self.assertEqual(events[0][1]["request_id"], str(request.request_id))
        client_factory.assert_called_once()
        self.assertEqual(client.exits, 1)
        self.assertEqual(client.response.exits, 1)
        save.assert_not_called()
        self.assertFalse(main.chat_lock.locked())

    async def test_stop_before_registration_is_unknown_and_does_not_poison_later_request(self):
        request = self.request()
        early = await main.cancel_chat_stream(request.request_id)
        self.assertEqual(early["status"], "unknown")

        response = FakeOllamaResponse([
            {"message": {"content": "normal completion"}, "done": True},
        ])
        client = FakeOllamaClient(response)
        with (
            patch("main.storage.conversation_exists", return_value=True),
            patch("main.storage.get_messages", return_value=[]),
            patch("main.httpx.AsyncClient", return_value=client),
            patch("main.storage.save_exchange") as save,
        ):
            stream = await main.chat_stream(request)
            events = await self.consume(stream)

        self.assertEqual([name for name, _ in events], ["text", "completion"])
        self.assertTrue(events[-1][1]["saved"])
        save.assert_called_once()

    async def test_cancel_during_stream_keeps_partial_text_and_does_not_save(self):
        request = self.request()
        response = FakeOllamaResponse()
        client = FakeOllamaClient(response)
        with (
            patch("main.storage.conversation_exists", return_value=True),
            patch("main.storage.get_messages", return_value=[]),
            patch("main.httpx.AsyncClient", return_value=client),
            patch("main.storage.save_exchange") as save,
        ):
            stream = await main.chat_stream(request)
            iterator = stream.body_iterator
            first_task = asyncio.create_task(iterator.__anext__())
            await response.started.wait()
            await response.push({"message": {"content": "partial"}, "done": False})
            first = await first_task
            terminal_task = asyncio.create_task(iterator.__anext__())
            cancel = await main.cancel_chat_stream(request.request_id)
            terminal_frame = await terminal_task
            status = await main.chat_stream_status(request.request_id)

        first_frame = first.decode() if isinstance(first, bytes) else first
        terminal_frame = terminal_frame.decode() if isinstance(terminal_frame, bytes) else terminal_frame
        self.assertIn('"text": "partial"', first_frame)
        terminal_lines = terminal_frame.splitlines()
        terminal_payload = json.loads(terminal_lines[1].removeprefix("data: "))
        self.assertEqual(cancel["status"], "cancelled")
        self.assertEqual(terminal_payload["request_id"], str(request.request_id))
        self.assertEqual(terminal_payload, cancel)
        self.assertEqual(terminal_payload, status)
        self.assertIn("event: cancelled", terminal_frame)
        save.assert_not_called()
        self.assertEqual(client.exits, 1)
        self.assertEqual(response.exits, 1)
        self.assertFalse(main.chat_lock.locked())

    async def test_cancel_while_waiting_for_chat_lock_is_pending_until_lock_release(self):
        request = self.request()
        await main.chat_lock.acquire()
        try:
            with (
                patch("main.storage.conversation_exists", return_value=True),
                patch("main.storage.get_messages", return_value=[]),
                patch("main.storage.save_exchange") as save,
            ):
                stream = await main.chat_stream(request)
                consume_task = asyncio.create_task(self.consume(stream))
                await asyncio.sleep(0)
                with patch.object(main, "CANCEL_ACK_TIMEOUT_SECONDS", 0.01):
                    pending = await main.cancel_chat_stream(request.request_id)
            self.assertEqual(pending["status"], "pending")
            self.assertTrue(pending["cancellation_requested"])
        finally:
            main.chat_lock.release()
        events = await consume_task
        self.assertEqual([name for name, _ in events], ["cancelled"])
        save.assert_not_called()
        self.assertEqual((await main.chat_stream_status(request.request_id))["status"], "cancelled")
        self.assertFalse(main.chat_lock.locked())

    async def test_completion_commit_wins_race_and_cancel_reports_save_error(self):
        request = self.request()
        state = await main.stream_requests.register(str(request.request_id))
        await state.decision_lock.acquire()
        commit_task = asyncio.create_task(main.commit_stream_reply(state, "conversation", "hello", "reply", []))
        await asyncio.sleep(0)
        cancel_task = asyncio.create_task(main.cancel_chat_stream(request.request_id))
        await asyncio.sleep(0)
        self.assertEqual(len(state.decision_lock._waiters), 2)
        state.decision_lock.release()
        with patch("main.storage.save_exchange", side_effect=sqlite3.OperationalError("test save failure")) as save:
            outcome = await commit_task
            await main.stream_requests.finish(state, outcome)
            cancelled = await cancel_task

        self.assertEqual(outcome["status"], "save_error")
        self.assertEqual(cancelled["status"], "save_error")
        self.assertFalse(cancelled["saved"])
        save.assert_called_once()

    async def test_successful_commit_wins_race_and_cancel_reports_saved(self):
        request = self.request()
        state = await main.stream_requests.register(str(request.request_id))
        await state.decision_lock.acquire()
        commit_task = asyncio.create_task(main.commit_stream_reply(state, "conversation", "hello", "reply", []))
        await asyncio.sleep(0)
        cancel_task = asyncio.create_task(main.cancel_chat_stream(request.request_id))
        await asyncio.sleep(0)
        self.assertEqual(len(state.decision_lock._waiters), 2)
        state.decision_lock.release()
        with patch("main.storage.save_exchange") as save:
            outcome = await commit_task
            await main.stream_requests.finish(state, outcome)
            cancelled = await cancel_task

        self.assertEqual(outcome["status"], "completed")
        self.assertTrue(outcome["saved"])
        self.assertEqual(cancelled["status"], outcome["status"])
        self.assertTrue(cancelled["saved"])
        save.assert_called_once_with("conversation", "hello", "reply")

    async def test_browser_disconnect_is_not_reported_as_explicit_cancellation(self):
        request = self.request()
        response = FakeOllamaResponse()
        client = FakeOllamaClient(response)
        with (
            patch("main.storage.conversation_exists", return_value=True),
            patch("main.storage.get_messages", return_value=[]),
            patch("main.httpx.AsyncClient", return_value=client),
            patch("main.storage.save_exchange") as save,
        ):
            stream = await main.chat_stream(request)
            iterator = stream.body_iterator
            first_task = asyncio.create_task(iterator.__anext__())
            await response.started.wait()
            await response.push({"message": {"content": "partial"}, "done": False})
            await first_task
            await iterator.aclose()
            status = await main.chat_stream_status(request.request_id)

        self.assertEqual(status["status"], "disconnected")
        self.assertFalse(status["saved"])
        save.assert_not_called()
        self.assertEqual(client.exits, 1)
        self.assertEqual(response.exits, 1)
        self.assertFalse(main.chat_lock.locked())

    async def test_cancellation_wins_commit_race_without_saving(self):
        request = self.request()
        state = await main.stream_requests.register(str(request.request_id))
        cancel_task = asyncio.create_task(main.cancel_chat_stream(request.request_id))
        await asyncio.sleep(0)
        with patch("main.storage.save_exchange") as save:
            outcome = await main.commit_stream_reply(state, "conversation", "hello", "partial", [])
            await main.stream_requests.finish(state, outcome)
            result = await cancel_task
        save.assert_not_called()
        self.assertEqual(result["status"], "cancelled")
        self.assertFalse(result["saved"])

    async def test_duplicate_stop_is_idempotent_and_duplicate_stream_id_is_rejected(self):
        request = self.request()
        stream = await main.chat_stream(request)
        with self.assertRaises(main.HTTPException) as duplicate:
            await main.chat_stream(request)
        self.assertEqual(duplicate.exception.status_code, 409)

        first_cancel = asyncio.create_task(main.cancel_chat_stream(request.request_id))
        second_cancel = asyncio.create_task(main.cancel_chat_stream(request.request_id))
        await asyncio.sleep(0)
        with (
            patch("main.storage.conversation_exists", return_value=True),
            patch("main.storage.get_messages", return_value=[]),
            patch("main.storage.save_exchange") as save,
        ):
            events = await self.consume(stream)
        first, second = await asyncio.gather(first_cancel, second_cancel)
        save.assert_not_called()
        self.assertEqual(first, second)
        self.assertEqual(first["status"], "cancelled")
        self.assertEqual([name for name, _ in events], ["cancelled"])

    async def test_unknown_request_id_does_not_target_an_active_request(self):
        request = self.request()
        state = await main.stream_requests.register(str(request.request_id))
        unknown_id = uuid4()
        cancel = await main.cancel_chat_stream(unknown_id)
        status = await main.chat_stream_status(unknown_id)
        self.assertEqual(cancel["status"], "unknown")
        self.assertEqual(status["status"], "unknown")
        self.assertFalse(state.cancel_event.is_set())
        await main.stream_requests.finish(state, {"status": "disconnected", "saved": False})

    async def test_normal_completion_persists_before_terminal_event_and_status_is_repeatable(self):
        record = {
            "id": 7,
            "memory_key": "preferred",
            "value": "caf\\u00e9",
            "origin": "explicit_user_request",
            "confirmation_status": "user_confirmed",
            "created_at": "2026-10-27T00:00:00Z",
        }
        request = self.request(memory_key="preferred")
        chunks = [
            {"message": {"content": "caf\\u00e9 "}, "done": False},
            {"message": {"content": "done"}, "done": True},
        ]
        response = FakeOllamaResponse(chunks)
        client = FakeOllamaClient(response)
        with (
            patch("main.storage.conversation_exists", return_value=True),
            patch("main.storage.get_messages", return_value=[]),
            patch("main.memory.validate_key"),
            patch("main.memory.get_record", return_value=record),
            patch("main.httpx.AsyncClient", return_value=client),
            patch("main.storage.save_exchange") as save,
        ):
            stream = await main.chat_stream(request)
            events = await self.consume(stream)
            outcome = await main.chat_stream_status(request.request_id)
            with self.assertRaises(main.HTTPException) as duplicate:
                await main.chat_stream(request)

        self.assertEqual(duplicate.exception.status_code, 409)
        self.assertEqual([name for name, _ in events], ["text", "text", "completion"])
        self.assertEqual(events[-1][1]["status"], "completed")
        self.assertTrue(events[-1][1]["saved"])
        self.assertEqual(events[-1][1]["request_id"], str(request.request_id))
        self.assertEqual(events[-1][1]["memory_used"], [record])
        self.assertEqual(events[-1][1], outcome)
        self.assertEqual(outcome["status"], "completed")
        self.assertEqual(save.call_args.args, (str(request.conversation_id), "hello", "caf\\u00e9 done"))
        self.assertEqual(client.request[2]["options"], {"num_ctx": 4096, "num_predict": 256})
        self.assertFalse(main.chat_lock.locked())

    async def test_cancelled_request_releases_lock_for_a_follow_up_request(self):
        first_request = self.request()
        first_response = FakeOllamaResponse()
        second_request = self.request()
        second_response = FakeOllamaResponse([
            {"message": {"content": "recovered"}, "done": True},
        ])
        first_client = FakeOllamaClient(first_response)
        second_client = FakeOllamaClient(second_response)
        clients = [first_client, second_client]
        with (
            patch("main.storage.conversation_exists", return_value=True),
            patch("main.storage.get_messages", return_value=[]),
            patch("main.httpx.AsyncClient", side_effect=lambda **kwargs: clients.pop(0)),
            patch("main.storage.save_exchange") as save,
        ):
            first_stream = await main.chat_stream(first_request)
            first_consumer = asyncio.create_task(self.consume(first_stream))
            await first_response.started.wait()
            first_outcome = await main.cancel_chat_stream(first_request.request_id)
            first_events = await first_consumer
            second_stream = await main.chat_stream(second_request)
            second_events = await self.consume(second_stream)

        self.assertEqual(first_outcome["status"], "cancelled")
        self.assertEqual([name for name, _ in first_events], ["cancelled"])
        self.assertEqual([name for name, _ in second_events], ["text", "completion"])
        save.assert_called_once_with(str(second_request.conversation_id), "hello", "recovered")
        self.assertEqual(first_client.exits, 1)
        self.assertEqual(second_client.exits, 1)
        self.assertFalse(main.chat_lock.locked())

    async def test_transport_failure_has_its_own_terminal_outcome(self):
        request = self.request()
        response = FakeOllamaResponse([httpx.ConnectError("isolated transport failure")])
        client = FakeOllamaClient(response)
        with (
            patch("main.storage.conversation_exists", return_value=True),
            patch("main.storage.get_messages", return_value=[]),
            patch("main.httpx.AsyncClient", return_value=client),
            patch("main.storage.save_exchange") as save,
        ):
            stream = await main.chat_stream(request)
            events = await self.consume(stream)
            status = await main.chat_stream_status(request.request_id)

        self.assertEqual([name for name, _ in events], ["error"])
        self.assertEqual(events[0][1]["status"], "transport_error")
        self.assertEqual(events[0][1]["request_id"], str(request.request_id))
        self.assertEqual(events[0][1], status)
        self.assertEqual(status["status"], "transport_error")
        save.assert_not_called()
        self.assertEqual(client.exits, 1)
        self.assertEqual(response.exits, 1)

    async def test_legacy_chat_endpoint_remains_non_streaming(self):
        request = main.ChatRequest(conversation_id=uuid4(), message="hello")
        client = FakeOllamaClient(FakeOllamaResponse())
        with (
            patch("main.storage.conversation_exists", return_value=True),
            patch("main.storage.get_messages", return_value=[]),
            patch("main.storage.save_exchange") as save,
            patch("main.httpx.AsyncClient", return_value=client),
        ):
            result = await main.chat(request)
        self.assertFalse(client.request[2]["stream"])
        self.assertEqual(result["reply"], "complete")
        save.assert_called_once()


if __name__ == "__main__":
    unittest.main()
