# Pharos 测试网自动化工具

用于与Pharos测试网交互，执行代币兑换、转账、水龙头领取以及每日签到

## 功能特点 ✨

- **自动兑换**：在WPHRS和USDC代币之间执行随机兑换操作
- **PHRS转账**：向随机地址发送少量PHRS代币
- **水龙头领取**：自动从测试网水龙头领取测试代币
- **每日签到**：完成每日签到任务以获取潜在奖励
- **代理支持**：为每次操作轮换使用代理（如果提供）
- **多钱包支持**：按顺序处理多个钱包
- **一键领水**：可以一键领水
- **批量归集**：可以一键归集水

## 系统要求 📋

- Node.js (v18或更高版本)
- npm

## 安装步骤 ⚙️

1. 安装依赖:
   ```bash
   npm install
   ```
2. (可选) 在`proxies.txt`中添加代理(每行一个):
   ```
   http://用户名:密码@IP:端口
   socks5://用户名:密码@IP:端口
   ```
3. 运行工具
   ```bash
   npm start
   ```

![4be26f2c5851510f140ef839ef4f6e1](https://github.com/user-attachments/assets/0b35e2cf-ac7a-4f2a-9136-5a723c8ce06b)

![397699f77804ce23e15df8e5902ab26](https://github.com/user-attachments/assets/7f7e0ea6-ced9-42eb-8a54-c09de76e3f6f)

![f4b4415c30e8a9afe2ee9e472d993bd](https://github.com/user-attachments/assets/2912a0f0-5363-4218-be56-2b15ef5e6579)
