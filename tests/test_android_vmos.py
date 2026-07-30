import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError

from android_worker.verify_session import verify
from android_worker.vmos_cloud import (
    ADB_LEASE_PATH,
    VmosAdbManager,
    VmosApiClient,
    VmosCloudError,
    VmosLease,
    parse_ssh_forward,
)


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


class VmosCloudTests(unittest.TestCase):
    def test_parse_vmos_ssh_forward(self):
        result = parse_ssh_forward(
            "ssh -oStrictHostKeyChecking=accept-new s@107.151.131.2 "
            "-p 1824 -L 60733:localhost:1 -Nf"
        )
        self.assertEqual(result.username, "s")
        self.assertEqual(result.hostname, "107.151.131.2")
        self.assertEqual(result.ssh_port, 1824)
        self.assertEqual(result.remote_host, "localhost")
        self.assertEqual(result.remote_port, 1)

    @patch("android_worker.vmos_cloud.time.time", return_value=1234567890)
    @patch("android_worker.vmos_cloud.urlopen")
    def test_v2_signature_and_seven_day_lease(self, urlopen, _):
        urlopen.return_value = _Response({
            "code": 200,
            "data": {
                "command": "ssh s@example -L 1:localhost:1",
                "key": "password",
                "adb": "adb connect localhost:1",
                "expireTime": "2030-01-01 00:00:00",
            },
        })
        client = VmosApiClient("access", "secret")
        client.get_adb_lease("PAD-1", 99999)
        request = urlopen.call_args.args[0]
        body = b'{"padCode":"PAD-1","enable":true,"expireMinutes":10080}'
        expected = hashlib.sha256(
            b"secret" + b"1234567890" + ADB_LEASE_PATH.encode() + body
        ).hexdigest()
        self.assertEqual(request.data, body)
        self.assertEqual(request.get_header("X-access-key"), "access")
        self.assertEqual(request.get_header("X-timestamp"), "1234567890")
        self.assertEqual(request.get_header("X-sign"), expected)

    @patch(
        "android_worker.vmos_cloud._VMOS_CLOCK_OFFSET_SECONDS",
        0.0,
    )
    @patch(
        "android_worker.vmos_cloud.time.time",
        return_value=1784998000,
    )
    @patch("android_worker.vmos_cloud.urlopen")
    def test_expired_timestamp_uses_vmos_clock_and_retries(
        self, urlopen, _
    ):
        clock_error = HTTPError(
            "https://api.vmoscloud.com/vcpcloud/api/padApi/adb",
            401,
            "Unauthorized",
            {},
            io.BytesIO(json.dumps({
                "msg": "Request timestamp expired or malformed",
                "code": 2033,
                "ts": 1784998690929,
            }).encode()),
        )
        urlopen.side_effect = [
            clock_error,
            _Response({
                "code": 200,
                "data": {
                    "command": "ssh s@example -L 1:localhost:1",
                    "key": "password",
                    "adb": "adb connect localhost:1",
                },
            }),
        ]

        VmosApiClient("access", "secret").get_adb_lease("PAD-1")

        self.assertEqual(urlopen.call_count, 2)
        retry_request = urlopen.call_args_list[1].args[0]
        self.assertEqual(
            retry_request.get_header("X-timestamp"),
            "1784998690",
        )

    @patch("android_worker.verify_session.discover_and_save_collections")
    @patch("android_worker.verify_session.CollectionApiWorker")
    def test_old_config_does_not_open_studio_to_discover_collections(
        self, worker_class, discover
    ):
        client = SimpleNamespace(
            credentials=[SimpleNamespace(token="saved")],
            check_login=lambda: None,
        )
        worker_class.return_value.slots = [
            SimpleNamespace(
                serial="localhost:60733",
                collection_url="https://www.youtube.com/shopcollection/SCUC1",
                client=client,
            )
        ]
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "android-worker.json"
            config_path.write_text(
                json.dumps({"adb_path": "adb.exe"}),
                encoding="utf-8",
            )
            result = verify(config_path)

        self.assertTrue(result["ok"])
        discover.assert_not_called()
        worker_class.return_value.connect_devices.assert_called_once()

    @patch("android_worker.vmos_cloud.time.sleep")
    def test_adb_connect_is_retried_while_cloud_endpoint_starts(
        self, sleep
    ):
        manager = VmosAdbManager(
            {
                "vmos": {
                    "enabled": True,
                    "connect_timeout_seconds": 60,
                    "connect_retry_seconds": 2,
                }
            },
            "adb.exe",
        )
        disconnected = SimpleNamespace(
            returncode=0, stdout="", stderr=""
        )
        first_attempt = SimpleNamespace(
            returncode=1, stdout="", stderr="not ready"
        )
        second_attempt = SimpleNamespace(
            returncode=0, stdout="connected", stderr=""
        )
        with patch.object(
            manager,
            "_adb",
            side_effect=[
                disconnected,
                first_attempt,
                disconnected,
                second_attempt,
            ],
        ) as adb, patch.object(
            manager, "_adb_online", side_effect=[False, True]
        ):
            manager._connect_adb()

        self.assertEqual(adb.call_count, 4)
        self.assertEqual(
            adb.call_args_list[0].args,
            ("disconnect", "localhost:60733"),
        )
        self.assertEqual(
            adb.call_args_list[2].args,
            ("disconnect", "localhost:60733"),
        )
        sleep.assert_called_once_with(2.0)

    @patch.dict(
        "os.environ", {"VMOS_REUSE_EXISTING_TUNNEL": "1"}, clear=False
    )
    @patch("android_worker.verify_session.VmosAdbManager")
    @patch("android_worker.verify_session.CollectionApiWorker")
    def test_verification_reuses_running_vmos_tunnel(
        self, worker_class, manager_class
    ):
        client = SimpleNamespace(
            credentials=[SimpleNamespace(token="saved")],
            check_login=lambda: None,
        )
        worker_class.return_value.slots = [
            SimpleNamespace(
                serial="localhost:60733",
                collection_url="https://www.youtube.com/shopcollection/SCUC1",
                client=client,
            )
        ]
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "android-worker.json"
            config_path.write_text(
                json.dumps(
                    {
                        "adb_path": "adb.exe",
                        "auto_discover_collections": False,
                        "vmos": {"enabled": True, "local_port": 60733},
                        "devices": [{"serial": "old-device"}],
                    }
                ),
                encoding="utf-8",
            )
            result = verify(config_path)

        self.assertTrue(result["ok"])
        manager_class.assert_not_called()
        runtime_config = worker_class.call_args.args[0]
        self.assertFalse(runtime_config["vmos"]["enabled"])
        self.assertEqual(
            runtime_config["devices"][0]["serial"], "localhost:60733"
        )

    @patch("android_worker.vmos_cloud.time.sleep")
    def test_failed_tunnel_is_replaced_with_a_fresh_lease(self, sleep):
        manager = VmosAdbManager(
            {
                "vmos": {
                    "enabled": True,
                    "tunnel_retry_count": 3,
                    "tunnel_retry_seconds": 2,
                }
            },
            "adb.exe",
        )
        leases = [
            VmosLease("ssh first", "key", "adb", 1),
            VmosLease("ssh second", "key", "adb", 2),
        ]
        with patch.object(
            manager, "_acquire_lease", side_effect=leases
        ) as acquire, patch.object(
            manager,
            "_replace_tunnel",
            side_effect=[VmosCloudError("offline"), None],
        ) as replace:
            manager._open_fresh_tunnel()

        self.assertEqual(acquire.call_count, 2)
        self.assertEqual(replace.call_count, 2)
        sleep.assert_called_once_with(2.0)


if __name__ == "__main__":
    unittest.main()
