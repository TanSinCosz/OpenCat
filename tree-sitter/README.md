# Tree-sitter JS 练习区

这个目录是独立的小练习项目，用来学习 `tree-sitter` 的 JavaScript 解析和查询能力，不影响仓库主项目。

## 准备

```powershell
cd tree-sitter
npm.cmd install
```

## 练习 1：打印 AST

```powershell
npm.cmd run parse
```

这个脚本会解析 `samples/hello.js`，并打印：

- 根节点类型
- AST 的 S-expression
- 文件中的函数名和位置

入口文件：[examples/parse-js.js](examples/parse-js.js)

## 练习 2：使用 Query 捕获节点

```powershell
npm.cmd run query
```

这个脚本会读取 [queries/javascript.scm](queries/javascript.scm)，捕获：

- `import` 语句
- 函数声明名
- 函数调用名

入口文件：[examples/query-js.js](examples/query-js.js)

## 建议的学习顺序

1. 先改 `samples/hello.js`，观察 AST 怎么变化。
2. 再改 `queries/javascript.scm`，练习新增或删除捕获规则。
3. 最后在 `examples/query-js.js` 里把捕获结果整理成你想要的数据结构。

常用心法：先用 `npm.cmd run parse` 看节点名字，再写 query。
