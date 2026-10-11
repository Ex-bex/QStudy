import hashlib
import json
import secrets
import tempfile
import unittest
import time
import os
import ssl
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import app
from app.models import User, PasswordResetToken, AcademicSetting
from app.auth import hash_password, create_access_token, verify_password
from app.config import settings
from app.services import password_recovery as recovery


class PasswordRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = create_engine('sqlite:///' + str(Path(self.temp.name) / 'test.db'), connect_args={'check_same_thread': False})
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.saved = (settings.RATE_LIMIT_ENABLED, settings.RECOVERY_DELIVERY, settings.PUBLIC_BASE_URL)
        settings.RATE_LIMIT_ENABLED = False
        settings.RECOVERY_DELIVERY = 'local'
        settings.PUBLIC_BASE_URL = 'http://127.0.0.1:3099'
        self.outbox = Path(self.temp.name) / 'private'
        self.outbox_patch = patch.object(recovery, 'LOCAL_OUTBOX', self.outbox)
        self.outbox_patch.start()
        def db_override():
            with self.factory() as db:
                yield db
        app.dependency_overrides[get_db] = db_override
        self.client = TestClient(app)
        with self.factory() as db:
            user = User(email='person@example.com', name='Test', role='student', hashed_password=hash_password('OriginalPassword33'))
            db.add(user)
            db.commit()
            self.user_id = user.id
        self.old_session = create_access_token(self.user_id)

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        settings.RATE_LIMIT_ENABLED, settings.RECOVERY_DELIVERY, settings.PUBLIC_BASE_URL = self.saved
        self.outbox_patch.stop()
        self.engine.dispose()
        self.temp.cleanup()

    def issue(self):
        response = self.client.post('/api/auth/forgot-password', json={'email': 'PERSON@example.com'})
        self.assertEqual(response.status_code, 200, response.text)
        files = list(self.outbox.glob('*.json'))
        with self.factory() as db:
            record = db.query(PasswordResetToken).order_by(PasswordResetToken.id.desc()).first()
            self.assertIsNotNone(record, 'Password recovery did not issue a token')
            self.assertEqual(record.delivery_status, 'delivered', 'Local recovery message was not delivered')
            latest = record.token_hash
        messages = [json.loads(path.read_text(encoding='utf-8')) for path in files]
        matching = [message for message in messages if hashlib.sha256(message['link'].split('#token=')[1].encode()).hexdigest() == latest]
        self.assertEqual(len(matching), 1, 'Expected one local message for the issued reset token')
        data = matching[0]
        self.assertTrue(data['link'].startswith('http://127.0.0.1:3099/reset-password#token='))
        token = data['link'].split('#token=')[1]
        self.assertNotIn(token, response.text)
        self.assertNotIn('link', response.json())
        return token

    def test_one_time_reset_revokes_sessions_and_keeps_account(self):
        token = self.issue()
        with self.factory() as db:
            record = db.query(PasswordResetToken).one()
            self.assertEqual(record.token_hash, hashlib.sha256(token.encode()).hexdigest())
            self.assertNotEqual(record.token_hash, token)
            self.assertEqual(record.delivery_status, 'delivered')
        response = self.client.post('/api/auth/reset-password', json={'token': token, 'new_password': 'ReplacementPassword44'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn('access_token', response.json())
        self.assertEqual(self.client.get('/api/auth/me', headers={'Authorization': 'Bearer ' + self.old_session}).status_code, 401)
        self.assertEqual(self.client.post('/api/auth/reset-password', json={'token': token, 'new_password': 'AnotherPassword44'}).status_code, 400)
        with self.factory() as db:
            user = db.get(User, self.user_id)
            self.assertEqual(user.role, 'student')
            self.assertTrue(verify_password('ReplacementPassword44', user.hashed_password))
            self.assertEqual(user.token_version, 1)

    def test_unknown_and_disabled_accounts_do_not_disclose_existence(self):
        existing = self.client.post('/api/auth/forgot-password', json={'email': 'person@example.com'})
        unknown = self.client.post('/api/auth/forgot-password', json={'email': 'unknown@example.com'})
        self.assertEqual(existing.json(), unknown.json())
        with self.factory() as db:
            user = db.get(User, self.user_id)
            user.is_active = False
            db.commit()
        inactive = self.client.post('/api/auth/forgot-password', json={'email': 'person@example.com'})
        self.assertEqual(existing.json(), inactive.json())

    def test_expired_superseded_and_password_changed_tokens_fail(self):
        first = self.issue()
        second = self.issue()
        payload = lambda value: {'token': value, 'new_password': 'ReplacementPassword44'}
        self.assertEqual(self.client.post('/api/auth/reset-password', json=payload(first)).status_code, 400)
        with self.factory() as db:
            record = db.query(PasswordResetToken).filter_by(token_hash=hashlib.sha256(second.encode()).hexdigest()).one()
            record.expires_at = recovery.now() - timedelta(seconds=1)
            db.commit()
        self.assertEqual(self.client.post('/api/auth/reset-password', json=payload(second)).status_code, 400)
        third = self.issue()
        with self.factory() as db:
            user = db.get(User, self.user_id)
            user.token_version += 1
            db.commit()
        self.assertEqual(self.client.post('/api/auth/reset-password', json=payload(third)).status_code, 400)

    def test_local_delivery_disabled_for_public_site(self):
        settings.PUBLIC_BASE_URL = 'https://study.example.com'
        self.assertEqual(self.client.get('/api/auth/recovery-options').json()['delivery'], 'disabled')
        self.assertEqual(self.client.post('/api/auth/forgot-password', json={'email': 'person@example.com'}).status_code, 503)

    def test_mail_failure_is_private_and_does_not_change_password(self):
        with patch.object(recovery, 'recovery_mode', return_value='smtp'), patch.object(recovery, '_send_email', side_effect=RuntimeError('sensitive SMTP detail')):
            response = self.client.post('/api/auth/forgot-password', json={'email': 'person@example.com'})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('sensitive', response.text)
        with self.factory() as db:
            self.assertEqual(db.query(PasswordResetToken).one().delivery_status, 'failed')
            self.assertTrue(verify_password('OriginalPassword33', db.get(User, self.user_id).hashed_password))

    def test_invalid_password_and_unknown_token(self):
        token = self.issue()
        self.assertEqual(self.client.post('/api/auth/reset-password', json={'token': token, 'new_password': '123456789012'}).status_code, 422)
        self.assertEqual(self.client.post('/api/auth/reset-password', json={'token': secrets.token_urlsafe(48), 'new_password': 'ReplacementPassword44'}).status_code, 400)

    def test_account_rate_limit_applies_to_unknown_and_existing(self):
        from app.security import _attempts, _lock
        settings.RATE_LIMIT_ENABLED = True
        with _lock:
            _attempts.clear()
        try:
            for _ in range(3):
                self.assertEqual(self.client.post('/api/auth/forgot-password', json={'email': 'unknown@example.com'}).status_code, 200)
            self.assertEqual(self.client.post('/api/auth/forgot-password', json={'email': 'unknown@example.com'}).status_code, 429)
        finally:
            with _lock:
                _attempts.clear()

    def test_local_opener_ignores_superseded_and_used_links(self):
        first = self.issue()
        second = self.issue()
        for path in self.outbox.glob('*.json'):
            if first in path.read_text(encoding='utf-8'):
                os.utime(path, (time.time() + 60, time.time() + 60))
        with self.factory() as db:
            link = recovery.find_local_reset_link(db, 'person@example.com', 'http://127.0.0.1:3101')
        self.assertEqual(link, 'http://127.0.0.1:3101/reset-password#token=' + second)
        self.assertEqual(self.client.post('/api/auth/reset-password', json={'token': second, 'new_password': 'ReplacementPassword44'}).status_code, 200)
        with self.factory() as db:
            self.assertIsNone(recovery.find_local_reset_link(db, 'person@example.com', 'http://127.0.0.1:3101'))

    @unittest.skipUnless(os.name == 'nt', 'Windows 8.3 path regression')
    def test_local_delivery_and_opener_accept_windows_short_path_alias(self):
        import ctypes
        buffer = ctypes.create_unicode_buffer(32768)
        get_short_path = ctypes.windll.kernel32.GetShortPathNameW
        get_short_path.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32)
        get_short_path.restype = ctypes.c_uint32
        result = get_short_path(str(self.outbox.parent), buffer, len(buffer))
        if not result or result >= len(buffer):
            self.skipTest('The temporary directory has no supported short path')
        alias = Path(buffer.value) / 'private'
        if alias.resolve() == alias.absolute():
            self.skipTest('The filesystem has 8.3 short names disabled')
        with patch.object(recovery, 'LOCAL_OUTBOX', alias), patch.object(recovery.os, 'chmod', wraps=os.chmod) as permissions:
            token = self.issue()
            with self.factory() as db:
                link = recovery.find_local_reset_link(db, 'person@example.com', 'http://127.0.0.1:3101')
            self.assertEqual(link, 'http://127.0.0.1:3101/reset-password#token=' + token)
            self.assertEqual(len(list(alias.glob('*.json'))), 1)
            permissions.assert_called_once()
            self.assertEqual(permissions.call_args.args[1], 0o600)

    def test_local_recovery_rejects_symlink_and_junction_ancestors(self):
        # The redirected ancestor may already exist before the outbox itself.
        for method in ('is_symlink', 'is_junction'):
            original = getattr(Path, method)
            def redirected(path, original=original):
                return path == self.outbox.parent or original(path)
            with self.subTest(redirect=method), patch.object(Path, method, new=redirected):
                with self.assertRaisesRegex(ValueError, 'redirected directory'):
                    recovery._write_private_message('person@example.com', 'fixture-token', 'fixture-link')
                with self.factory() as db:
                    self.assertIsNone(recovery.find_local_reset_link(db, 'person@example.com', 'http://127.0.0.1:3101'))
                self.assertFalse(self.outbox.exists())

    def test_restore_cutoff_revokes_old_session_and_accepts_new_same_second(self):
        with self.factory() as db:
            db.add(AcademicSetting(key='auth_min_iat', value=str(time.time())))
            db.commit()
        self.assertEqual(self.client.get('/api/auth/me', headers={'Authorization': 'Bearer ' + self.old_session}).status_code, 401)
        fresh = create_access_token(self.user_id)
        self.assertEqual(self.client.get('/api/auth/me', headers={'Authorization': 'Bearer ' + fresh}).status_code, 200)

    def test_concurrent_reset_claim_only_one_password_wins(self):
        token = self.issue()
        # Do not run the application's lifespan against the real database.
        def isolated_attempt(value):
            client = TestClient(app)
            try:
                return client.post('/api/auth/reset-password', json={'token': token, 'new_password': value}).status_code
            finally:
                client.close()
        passwords = ['RacePasswordNumber11', 'RacePasswordNumber22']
        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(executor.map(isolated_attempt, passwords))
        self.assertEqual(sorted(statuses), [200, 400])
        with self.factory() as db:
            user = db.get(User, self.user_id)
            self.assertEqual(user.token_version, 1)
            self.assertTrue(verify_password(passwords[statuses.index(200)], user.hashed_password))


class SMTPDeliveryTests(unittest.TestCase):
    def test_starttls_encrypts_before_login_and_verifies_certificates(self):
        with patch.multiple(settings, SMTP_HOST='smtp.fixture.example', SMTP_PORT=587,
                            SMTP_FROM='qstudy@fixture.example', SMTP_USERNAME='fixture-user',
                            SMTP_PASSWORD='fixture-only-password', SMTP_SECURITY='starttls'), \
                patch.object(recovery.smtplib, 'SMTP') as constructor:
            server = constructor.return_value.__enter__.return_value
            recovery._send_email('student@fixture.example', 'Fixture message', 'QStudy fixture')
            constructor.assert_called_once_with('smtp.fixture.example', 587, timeout=15)
            self.assertEqual([call[0] for call in server.mock_calls],
                             ['ehlo', 'starttls', 'ehlo', 'login', 'send_message'])
            context = server.starttls.call_args.kwargs['context']
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(context.check_hostname)
            message = server.send_message.call_args.args[0]
            self.assertEqual(message['From'], 'QStudy <qstudy@fixture.example>')
            self.assertEqual(message['From'].addresses[0].display_name, 'QStudy')
            self.assertEqual(message['To'], 'student@fixture.example')

    def test_ssl_encrypts_connection_and_supports_unauthenticated_relay(self):
        with patch.multiple(settings, SMTP_HOST='smtp.fixture.example', SMTP_PORT=465,
                            SMTP_FROM='qstudy@fixture.example', SMTP_USERNAME='', SMTP_SECURITY='ssl'), \
                patch.object(recovery.smtplib, 'SMTP_SSL') as constructor:
            server = constructor.return_value.__enter__.return_value
            recovery._send_email('student@fixture.example', 'Fixture message', 'QStudy fixture')
            self.assertEqual(constructor.call_args.args, ('smtp.fixture.example', 465))
            self.assertEqual(constructor.call_args.kwargs['timeout'], 15)
            context = constructor.call_args.kwargs['context']
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(context.check_hostname)
            server.starttls.assert_not_called()
            server.login.assert_not_called()
            server.send_message.assert_called_once()

    def test_explicit_sender_display_name_is_preserved(self):
        for sender, expected in (('QStudy Support <team@fixture.example>', 'QStudy Support'),
                                 ('"Doe, Jane" <team@fixture.example>', 'Doe, Jane'),
                                 ('Команда QStudy <team@fixture.example>', 'Команда QStudy')):
            with self.subTest(sender=sender), patch.multiple(settings, SMTP_HOST='smtp.fixture.example', SMTP_PORT=587,
                    SMTP_FROM=sender, SMTP_USERNAME='', SMTP_SECURITY='starttls'), \
                    patch.object(recovery.smtplib, 'SMTP') as constructor:
                recovery._send_email('student@fixture.example', 'Fixture message', 'QStudy fixture')
                server = constructor.return_value.__enter__.return_value
                message = server.send_message.call_args.args[0]
                self.assertEqual(len(message['From'].addresses), 1)
                self.assertEqual(message['From'].addresses[0].display_name, expected)
                self.assertEqual(message['From'].addresses[0].addr_spec, 'team@fixture.example')

    def test_invalid_multiple_or_injected_senders_reject_before_connecting(self):
        senders = ('', ' ', 'not-an-email', 'person@', 'QStudy <person@example.com> garbage',
                   'first@example.com, second@example.com', 'Group: person@example.com;',
                   'person@example.com\r\nBcc: other@example.com', 'QStudy\n<person@example.com>',
                   'person@example.com\x00', 'QStudy <person@example.com')
        for sender in senders:
            with self.subTest(sender=sender), patch.object(settings, 'SMTP_FROM', sender), \
                    patch.object(recovery.smtplib, 'SMTP') as smtp, \
                    patch.object(recovery.smtplib, 'SMTP_SSL') as smtp_ssl:
                with self.assertRaisesRegex(ValueError, 'Invalid mail sender'):
                    recovery._send_email('student@fixture.example', 'Fixture message', 'QStudy fixture')
                smtp.assert_not_called()
                smtp_ssl.assert_not_called()


if __name__ == '__main__':
    unittest.main()
