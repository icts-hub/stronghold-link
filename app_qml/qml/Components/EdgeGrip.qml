import QtQuick

// 无边框窗口的边缘缩放热区。
//
// 为什么是独立文件而不是 QML 内联组件（component EdgeGrip: MouseArea { ... }）：
// Qt 6.8.3 的 qmlformat 解析不了内联组件、直接以退出码 1 失败（qmllint 与运行期都接受），
// 而仓库的语法检查 tools/qml-parse-check.cjs 用的就是 qmlformat —— 内联组件会让
// "QML 语法检查" 这一步永远红着。拆成文件后两边都过。
MouseArea {
    id: grip

    // 拖哪个边/角：Qt.LeftEdge / Qt.RightEdge / Qt.TopEdge / Qt.BottomEdge 的按位或。
    required property int edges

    acceptedButtons: Qt.LeftButton
    onPressed: {
        const w = Window.window;
        if (w)
            w.startSystemResize(grip.edges);
    }
}
