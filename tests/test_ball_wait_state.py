"""纸飞机等待态回归：投递后必须看得出「已投出 / 正在等 ta 回话」，
并且收到回话后弹窗留在原地、不再自动收起。

真实 Qt、offscreen 平台，不显示也不操作桌面窗口；/send 用闸门卡住，
让等待态在事件循环里真实存在一段时间，而不是瞬间跳过。

运行：python -B tests/test_ball_wait_state.py
"""
import os
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path


def run_child():
    import importlib.util
    import tempfile
    os.environ['QT_QPA_PLATFORM'] = 'offscreen'
    sys.dont_write_bytecode = True
    with tempfile.TemporaryDirectory(prefix='bqb-wait-') as temp:
        os.environ['BIAOQINGBAO_BALL_STATE_PATH'] = str(Path(temp) / 'state.json')
        root = Path(__file__).resolve().parents[1] / 'python'
        sys.path.insert(0, str(root))
        spec = importlib.util.spec_from_file_location('ball_under_test', root / 'ball_app.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        import faulthandler
        faulthandler.enable(all_threads=True)

        gate = threading.Event()
        fail_next = {'on': False}
        sessions = [{'agentName': '小花', 'agentId': 'hanako', 'title': '纸飞机联调',
                     'sessionPath': 'wait.jsonl'}]

        def request(method, route, payload=None, timeout=10):
            if route == '/send':
                gate.wait(8)
                if fail_next['on']:
                    fail_next['on'] = False
                    return {'ok': False, 'error': '模拟失败'}
                return {'ok': True}
            if route == '/pinned':
                return {'ok': True, 'stickers': [{'id': 's1', 'description': '开心'}]}
            if route == '/target':
                return {'ok': True, 'mode': 'auto', 'pinned': None, 'target': sessions[0]}
            if route == '/sessions':
                return {'ok': True, 'mode': 'auto', 'pinned': None, 'sessions': sessions}
            return {'ok': True, 'items': [], 'match': None}

        module.request_json = request
        module.load_image_data = lambda sticker_id: None

        app = module.QApplication([])
        app.setQuitOnLastWindowClosed(False)
        ball = module.Ball()
        panel = ball.panel
        panel.prepare_for_show()
        panel.show()

        seen = {'dots': set(), 'waiting_prop': False, 'card_visible': False,
                'button_text': '', 'sub_prefix_ok': False, 'sent': False,
                'stays_open': False, 'esc_closed': False, 'hint_back': False,
                'error_card_hidden': False, 'error_waiting_off': False,
                'error_button_text': ''}
        phase = {'name': 'idle'}
        started = {'t': time.time()}
        errors = []

        def fail(message):
            errors.append(message)
            app.quit()

        def tick():
            if errors:
                return
            try:
                name = phase['name']
                elapsed = time.time() - started['t']
                if name == 'idle':
                    if not panel.items:
                        if elapsed > 8:
                            fail('图集一直没加载出来')
                        return
                    panel.selected_sticker_id = 's1'
                    panel.editor.setPlainText('今天真巴适')
                    panel.send_selected()
                    phase['name'] = 'waiting'
                    started['t'] = time.time()
                    return
                if name == 'waiting':
                    if not panel.busy:
                        # 闸门放开、回包已到：交给下一段验收收尾态
                        phase['name'] = 'await_done'
                        started['t'] = time.time()
                        return
                    if not panel.wait_card.isVisible():
                        fail('等待态卡片必须可见')
                    else:
                        seen['card_visible'] = True
                    if panel.send_button.property('waiting') is not True:
                        fail('等待态按钮 waiting 属性应为 True')
                    else:
                        seen['waiting_prop'] = True
                    seen['button_text'] = panel.send_button.text()
                    if not panel.wait_card.sub.text().startswith('正在等'):
                        fail('等待文案应说明正在等回话：' + panel.wait_card.sub.text())
                    else:
                        seen['sub_prefix_ok'] = True
                    seen['dots'].add(panel.wait_card.sub.text())
                    if elapsed > 1.2 and not gate.is_set():
                        gate.set()
                    if elapsed > 6:
                        fail('闸门放开后仍未拿到回包')
                    return
                if name == 'await_done':
                    if panel.busy:
                        if elapsed > 6:
                            fail('回包后 busy 应收回 False')
                        return
                    if panel.wait_card.property('sent') is not True:
                        fail('收到回包后等待卡应切到已发出态')
                    else:
                        seen['sent'] = True
                    if '已确认发出' not in panel.wait_card.title.text():
                        fail('收尾文案应写明已确认发出：' + panel.wait_card.title.text())
                    if panel.send_button.property('waiting') is not False:
                        fail('结束后按钮 waiting 属性应回到 False')
                    if not seen['dots'] or len(seen['dots']) < 2:
                        fail('等待期间省略号应动起来，实际文案：%r' % (sorted(seen['dots']),))
                    if not panel.isVisible():
                        fail('回包后弹窗应留在原地，不再自动关闭')
                    else:
                        seen['stays_open'] = True
                    seen['hint_back'] = panel.hint.isVisible()
                    if not seen['hint_back']:
                        fail('等待结束后提示行应恢复')
                    if not panel.editor.isEnabled():
                        fail('等待结束后输入框应恢复可编辑')
                    # 重新选一张就应该能接着发（发完那张已取消选中，按钮此时理应是灰的）
                    if panel.send_button.isEnabled():
                        fail('发完后未选图时发送按钮理应不可点')
                    panel.selected_sticker_id = 's1'
                    panel.update_button_states()
                    if not panel.send_button.isEnabled():
                        fail('重新选一张后应能接着发下一张')
                    panel.selected_sticker_id = None
                    panel.update_button_states()
                    phase['name'] = 'await_esc'
                    started['t'] = time.time()
                    return
                if name == 'await_esc':
                    if elapsed < 0.4:
                        return
                    if panel.isVisible():
                        panel._close_shortcut.activated.emit()
                        if panel.isVisible():
                            fail('Esc 快捷键应能关掉面板')
                            return
                    seen['esc_closed'] = True
                    # 第三段：失败路径不能留下等待态
                    fail_next['on'] = True
                    panel.prepare_for_show()
                    panel.show()
                    panel.selected_sticker_id = 's1'
                    panel.editor.setPlainText('再试一次')
                    panel.send_selected()
                    phase['name'] = 'await_error'
                    started['t'] = time.time()
                    return
                if name == 'await_error':
                    if panel.busy:
                        if elapsed > 6:
                            fail('失败回包后 busy 应收回 False')
                        return
                    seen['error_card_hidden'] = panel.wait_card.isHidden()
                    seen['error_waiting_off'] = panel.send_button.property('waiting') is False
                    seen['error_button_text'] = panel.send_button.text()
                    if not seen['error_card_hidden']:
                        fail('失败后等待卡应收起')
                    if not seen['error_waiting_off']:
                        fail('失败后按钮 waiting 属性应回到 False')
                    if seen['error_button_text'] != '发送':
                        fail('失败后按钮文案应回到发送：' + seen['error_button_text'])
                    timer.stop()
                    panel.shutdown()
                    print('PASS real Qt wait-state flow ' + repr(sorted(seen)), flush=True)
                    app.quit()
            except Exception as error:  # noqa: BLE001 - 子进程里要留下原因
                fail(repr(error))

        timer = module.QTimer(panel)
        timer.timeout.connect(tick)
        timer.start(100)
        module.QTimer.singleShot(30000, app.quit)
        app.exec()
        timer.stop()
        ball.close()
        app.processEvents()
        panel._worker_drain_timer.stop()
        from PyQt6 import sip
        sip.delete(panel)
        sip.delete(ball)
        assert not errors, errors
        assert seen['card_visible'] and seen['waiting_prop'] and seen['sub_prefix_ok']
        assert seen['sent'] and seen['stays_open'] and seen['esc_closed'] and seen['hint_back']
        assert seen['error_card_hidden'] and seen['error_waiting_off']


class WaitStateTest(unittest.TestCase):
    def test_waiting_state_is_visible_and_stays_after_reply(self):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', QT_QPA_PLATFORM='offscreen')
        result = subprocess.run([sys.executable, '-B', __file__, '--child'],
                                env=env, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0,
                         'exit=' + hex(result.returncode & 0xffffffff) + '\n' +
                         result.stdout.decode('utf-8', 'replace')[-800:] + '\n' +
                         result.stderr.decode('utf-8', 'replace')[-6000:])
        self.assertIn(b'PASS real Qt wait-state flow', result.stdout)


if __name__ == '__main__':
    if '--child' in sys.argv:
        run_child()
    else:
        unittest.main()
