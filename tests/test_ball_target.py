"""Real Qt target flow regression, offscreen and without host/data writes.
Run: python -B tests/test_ball_target.py
"""
import os
import subprocess
import sys
import unittest
from pathlib import Path


def run_child():
    import importlib.util
    import tempfile
    os.environ['QT_QPA_PLATFORM'] = 'offscreen'
    sys.dont_write_bytecode = True
    with tempfile.TemporaryDirectory(prefix='bqb-target-') as temp:
        os.environ['BIAOQINGBAO_BALL_STATE_PATH'] = str(Path(temp) / 'state.json')
        root = Path(__file__).resolve().parents[1] / 'python'
        sys.path.insert(0, str(root))
        spec = importlib.util.spec_from_file_location('ball_under_test', root / 'ball_app.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        import faulthandler
        faulthandler.enable(all_threads=True)
        sessions = [{'agentName': 'Partner', 'agentId': 'test', 'title': 'Conversation ' + str(i),
                     'sessionPath': str(i) + '.jsonl'} for i in range(5)]
        state = {'pinned': None}

        def request(method, route, payload=None, timeout=10):
            if route == '/target':
                if method == 'POST':
                    state['pinned'] = payload if payload and payload.get('sessionPath') else None
                    return {'ok': True}
                return {'ok': True, 'mode': 'pinned' if state['pinned'] else 'auto',
                        'pinned': state['pinned'], 'target': state['pinned'] or sessions[0]}
            if route == '/sessions':
                return {'ok': True, 'mode': 'pinned' if state['pinned'] else 'auto',
                        'pinned': state['pinned'], 'sessions': sessions}
            return {'ok': True, 'items': [], 'match': None}

        module.request_json = request
        app = module.QApplication([])
        app.setQuitOnLastWindowClosed(False)
        ball = module.Ball()
        panel = ball.panel
        panel.prepare_for_show()
        panel.show()
        count = 0
        stopping = False
        observations = set()
        errors = []

        def choose(pinned):
            if stopping:
                return
            if pinned:
                panel.target_menu._pick(sessions[1])
            else:
                panel.target_menu._pick_auto()

        def tick():
            nonlocal count, stopping
            try:
                if count:
                    assert len(panel.target_menu.sessions) == 5
                    observations.add(ball.target_mode)
                count += 1
                if count > 60:
                    stopping = True
                    assert observations == {'pinned', 'auto'}, observations
                    assert all(w.is_finished() for w in panel.target_menu.workers)
                    timer.stop()
                    panel.shutdown()
                    print('PASS 60 real Qt list/pinned/auto cycles', flush=True)
                    app.quit()
                    return
                panel._sync_target_state()
                panel._set_target_selector_visible(True)
                panel.target_menu.view_mode = 'pinned'
                panel.target_menu.refresh_sessions_async()
                # Leave enough event-loop time for the list request to complete.
                module.QTimer.singleShot(60, lambda pinned=bool(count % 2): choose(pinned))
            except Exception as error:
                errors.append(repr(error))
                app.quit()

        timer = module.QTimer(panel)
        timer.timeout.connect(tick)
        timer.start(120)
        module.QTimer.singleShot(15000, app.quit)
        app.exec()
        # Tear down top-level widgets while QApplication is still alive.
        # BallPanel has no Qt parent; leaving its timer/widgets to Python local
        # cleanup makes the QApplication/widget destruction order implicit.
        stopping = True
        timer.stop()
        ball.close()
        app.processEvents()
        panel._worker_drain_timer.stop()
        from PyQt6 import sip
        sip.delete(panel)
        sip.delete(ball)
        assert not errors, errors
        assert count > 60, count


class TargetFlowTest(unittest.TestCase):
    def test_real_qt_completion_callbacks_do_not_abort(self):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', QT_QPA_PLATFORM='offscreen')
        result = subprocess.run([sys.executable, '-B', __file__, '--child'],
                                env=env, capture_output=True, timeout=25)
        self.assertEqual(result.returncode, 0,
                         'exit=' + hex(result.returncode & 0xffffffff) + '\n' +
                         result.stdout.decode('utf-8', 'replace')[-500:] + '\n' +
                         result.stderr.decode('utf-8', 'replace')[-6000:])
        self.assertIn(b'PASS 60', result.stdout)


if __name__ == '__main__':
    if '--child' in sys.argv:
        run_child()
    else:
        unittest.main()
